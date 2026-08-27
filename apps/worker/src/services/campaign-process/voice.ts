/**
 * Voice-channel handler for the unified campaign-process worker
 * (aggregator-dpg#577).
 *
 * Runs one `campaign_job` with `channel: 'voice'`: decrypts the job's still-open
 * items (chunked, contact projection = name/phone + the requested item_state
 * variables), builds a single Raya dispatch batch from every resolved item
 * that has a phone number, and persists the provider's per-contact accept/
 * reject outcome back onto the items. This is a one-shot dispatch (create +
 * start) — there is deliberately no polling or reconciliation here; once
 * contacts are submitted, Raya owns the downstream call outcome.
 *
 * Retry safety: `markSubmitted` writes `status: 'submitted'` and
 * `raya_batch_id` in the same statement, so the presence of a `raya_batch_id`
 * on any item is proof a prior attempt already created a batch at the
 * provider. This handler never re-dispatches once that's true — but it does
 * not simply no-op: any item still `resolved` (decrypted before the crash,
 * never persisted after) is resumed by marking it `submitted` under the
 * already-known batch id, best-effort. Without this, a `resolved` item
 * counts as "succeeded" in `deriveJobStatus`, so `runCampaignJob` would roll
 * the job straight to `completed`/`partial` in the SAME attempt — and since
 * the watchdog only reconciles `processing` jobs, that item would stay
 * `resolved` with no `raya_batch_id` forever. The resume is best-effort (it
 * cannot know whether Raya actually accepted or rejected that specific
 * contact — the accepted/rejected split from the crashed attempt's dispatch
 * call was never persisted); the campaign manager polls Raya directly for
 * the real per-contact outcome. Items already in a terminal status
 * (submitted/failed/skipped/duplicate_active) are never re-decrypted or
 * re-included in a new batch.
 *
 * That guard only closes the window AFTER a `raya_batch_id` is durably
 * written. `dispatch()` itself is two non-atomic HTTP calls (create, then
 * start) with no client idempotency key, and its outcome is only persisted
 * by this handler's own writes afterwards — so there remains a genuine,
 * un-closeable crash window: if the worker process dies after `dispatch()`
 * returns success but before the FIRST `markSubmitted`/`setProviderResponse`
 * call commits, no item yet carries a `raya_batch_id`, the guard above does
 * not engage, and a retry will call `dispatch()` again — creating a second
 * batch and placing duplicate live calls to the same recipients. This is
 * inherent to fire-and-record against a provider with no idempotency key,
 * not a bug this handler can close from its own side.
 *
 * A *deterministic* dispatch failure (Raya rejects the create or start
 * request itself — bad key, or a required start field the caller omitted,
 * e.g. `max_concurrent_calls`/`selected_statuses`, aggregator-dpg#577 spec
 * §8.1) is different: retrying the identical request would fail identically,
 * and since create can succeed before start 400s, a BullMQ retry would mint
 * a fresh orphan batch at Raya on every attempt. So `AuthError`/
 * `ValidationError` from `dispatch()` are treated as TERMINAL — the
 * dispatched items are marked `failed` with Raya's specific reason and the
 * handler returns normally (no throw, no BullMQ retry, no orphan
 * multiplication). Only a transient failure (`UpstreamError`: 5xx, network,
 * exhausted retries) still throws to retry.
 *
 * Never logs contact PII (name/phone/variables) — only counts and item ids.
 * Belongs to `@aggregator-dpg/worker`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import {
  AuthError,
  ValidationError,
  type BaseError,
} from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackDecryptedProfileRow,
  SignalStackDecryptedProfiles,
  SignalStackFetchDecryptedProfilesQuery,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { VoiceContact, VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import { TERMINAL_ITEM_STATUSES, type ProcessingJob } from '../campaign-job-client.js';
import { chunkArray, truncateReason, type CampaignJobDeps } from './index.js';

/** Voice collaborators — narrow so the handler is trivially faked (see the export twin, `ExportCollaborators`). */
export interface VoiceCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  provider: VoiceProviderBase;
}

/**
 * Minimal twin of `apps/api/src/campaign/voice-content.ts`'s `VoiceContent`
 * (only the fields this handler reads). The worker has no `@aggregator-dpg/api`
 * workspace dependency — apps don't import each other's `src`, the same
 * app-boundary constraint `campaign-job-client.ts` documents for its
 * `deriveJobStatus` twin — so this is duplicated rather than imported.
 * `job.content` was already validated against `voiceContentSchema` by the API
 * at job-creation time; this reads the trusted JSONB shape.
 */
interface VoiceJobContent {
  agent_id: string;
  batch_name?: string;
  variables?: string[];
  schedule?: unknown;
  max_retries?: number;
  retry_after_hrs?: number;
  max_concurrent_calls?: number;
  selected_statuses?: string[];
}

/** Raya start-options passthrough keys — twin of `voice-content.ts`'s `START_KEYS`. */
const START_OPTION_KEYS = [
  'schedule',
  'max_retries',
  'retry_after_hrs',
  'max_concurrent_calls',
  'selected_statuses',
] as const;

/**
 * Extracts Raya start options from the voice content, forwarding only the
 * keys actually present — twin of `voice-content.ts`'s `voiceStartOptions`.
 *
 * @param content - The parsed voice job content.
 * @returns Record with only the supplied passthrough keys.
 */
function voiceStartOptions(content: VoiceJobContent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of START_OPTION_KEYS) {
    const value = content[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Reads + minimally validates the voice job's `content` JSONB.
 *
 * @param content - The job's raw `content` column.
 * @returns The typed voice content.
 * @throws {Error} If `agent_id` is missing — a malformed row the API's
 *   `voiceContentSchema` should never have let through. Retrying will not fix
 *   this, but it must surface loudly rather than dispatch to an empty agent.
 */
function parseVoiceContent(content: Record<string, unknown>): VoiceJobContent {
  const agentId = content['agent_id'];
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('campaign voice job content missing agent_id');
  }
  return content as unknown as VoiceJobContent;
}

/**
 * Flattens a decrypted item's `item_state` into the string-only variable map
 * Raya's call templates expect. Non-scalar values (arrays/objects) are
 * JSON-stringified rather than coerced to `"[object Object]"`; `null`/
 * `undefined` entries are dropped rather than becoming the literal string
 * `"null"`/`"undefined"`.
 *
 * @param itemState - The decrypted item's `item_state`.
 * @returns Flattened `{ key: string }` call variables.
 */
function flattenVariables(itemState: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(itemState)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

/**
 * Builds a human-readable failure reason from a deterministic dispatch error
 * (`AuthError`/`ValidationError`), preferring the specific message Raya's
 * response body carries (e.g. `"max_concurrent_calls is required"`) over the
 * adapter's generic `"raya /batch/{id}/start returned 400"` — so the
 * campaign manager sees the real cause, not just an HTTP status summary.
 * `raya.ts` attaches the raw response text as `error.details.body`; this
 * best-effort-parses it as JSON and extracts a `message` field (Raya's
 * observed error-body shape), falling back to the raw body text, then to
 * just the adapter's own message if no body is present.
 *
 * @param error - The typed error from `VoiceProviderBase.dispatch`.
 * @returns A reason string for `campaign_job_item.error_reason`, bounded by {@link truncateReason}.
 */
function describeDispatchFailure(error: BaseError): string {
  const body = error.details?.['body'];
  if (typeof body !== 'string' || body.length === 0) {
    return truncateReason(error.message);
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const parsedMessage = parsed['message'];
    if (typeof parsedMessage === 'string' && parsedMessage.length > 0) {
      return truncateReason(`${error.message}: ${parsedMessage}`);
    }
  } catch {
    // Non-JSON body — fall through to the raw body text.
  }
  return truncateReason(`${error.message}: ${body}`);
}

/** Shared log fields stamped on every `campaign.voice` log line for one job. */
interface VoiceLogBase {
  operation: 'campaign.voice';
  job_id: string;
  org_id: string;
}

/**
 * Handles a failed `dispatch()` call. A deterministic client-side rejection
 * (`AuthError`/`ValidationError`) is terminal — see the module note on why
 * retrying would multiply orphan batches at Raya: it marks every dispatched
 * contact `failed` with Raya's specific reason and returns normally so the
 * caller can return too (no throw, no BullMQ retry). Any other error
 * (`UpstreamError`: 5xx/network/exhausted retries) is transient and is
 * re-thrown so BullMQ retries the job.
 *
 * @param job - The job being processed.
 * @param deps - Injected job-client + logger.
 * @param contacts - The contacts included in the failed dispatch call.
 * @param error - The typed error from `VoiceProviderBase.dispatch`.
 * @param base - Shared log fields for this job (`operation`/`job_id`/`org_id`).
 * @throws {Error} Re-throws (wrapped) for a transient dispatch failure.
 */
async function handleDispatchFailure(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  contacts: VoiceContact[],
  error: BaseError,
  base: VoiceLogBase,
): Promise<void> {
  if (!(error instanceof AuthError || error instanceof ValidationError)) {
    // Transient (UpstreamError: 5xx/network/exhausted retries) — retryable.
    throw new Error(`campaign voice dispatch failed: ${error.code}: ${error.message}`);
  }
  // Deterministic client-side rejection — see the module note on why this is
  // terminal rather than retried (create may already have succeeded before
  // start 400'd; retrying would multiply orphan batches at Raya). No
  // providerResponse is available on this path — dispatch() failed before
  // returning one — so there's nothing to persist there beyond the per-item
  // reason.
  const reason = describeDispatchFailure(error);
  for (const contact of contacts) {
    await deps.client.markItem(job.id, contact.ref, 'failed', reason);
  }
  deps.log.warn({
    ...base,
    status: 'failed',
    reason: 'dispatch_rejected',
    error_code: error.code,
    error_type: error.constructor.name,
    dispatched: contacts.length,
  });
}

/**
 * Decrypts every still-open item on the job (chunked), marking each
 * `resolved`/`skipped_not_owned` as it goes and beating the heartbeat per
 * chunk. Items already in a terminal status (submitted, failed, skipped,
 * duplicate_active) are excluded from the request entirely — a retry never
 * re-decrypts or re-dispatches them. Re-throws on a transient decrypt
 * failure so BullMQ retries.
 *
 * @param job - The job being processed.
 * @param deps - Injected collaborators (client, config).
 * @param voice - The voice collaborators (already null-checked by the caller).
 * @param fields - `item_state` field projection (`content.variables`); `undefined` = full item_state.
 * @returns The resolved profile rows (owned items only).
 */
async function decryptVoiceItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  voice: VoiceCollaborators,
  fields: string[] | undefined,
): Promise<SignalStackDecryptedProfileRow[]> {
  const openItemIds = job.items
    .filter((i) => !TERMINAL_ITEM_STATUSES.includes(i.status))
    .map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(openItemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      contact: ['name', 'phone'],
      ...(fields ? { fields } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await voice.fetchDecryptedProfiles(query);
    if (!result.success) {
      throw new Error(
        `campaign voice decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    for (const p of profiles) {
      resolvedRows.push(p);
      await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/**
 * Runs the voice channel for one job: chunked decrypt → contact build →
 * single Raya dispatch → per-item accept/reject persist. No polling or
 * reconciliation — the roll-up (in `runCampaignJob`) derives the job status
 * from whatever item statuses this leaves behind.
 *
 * @param job - The job to process (`job.channel === 'voice'`).
 * @param deps - Injected job-client, voice collaborators, config, logger.
 * @throws {Error} If `deps.voice` is not wired, decrypt fails, or the
 *   provider dispatch itself fails (all retryable via BullMQ).
 */
export async function runVoiceForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const voice = deps.voice;
  if (!voice) {
    throw new Error('campaign voice channel requires voice collaborators (deps.voice)');
  }
  const base: VoiceLogBase = {
    operation: 'campaign.voice',
    job_id: job.id,
    org_id: job.signalstackOrgId,
  };

  // Retry-safety guard: a raya_batch_id proves a batch was already created on
  // a prior attempt (see module note) — never dispatch a second one. Resume
  // the persist instead of a bare no-op: mark every item still `resolved`
  // (decrypted but never persisted before the crash) submitted under the
  // known batch, so it stops silently reading as "succeeded" with no
  // raya_batch_id.
  const existingBatchId = job.items.find((i) => i.rayaBatchId)?.rayaBatchId;
  if (existingBatchId) {
    const unresolved = job.items.filter((i) => i.status === 'resolved');
    for (const item of unresolved) {
      await deps.client.markSubmitted(job.id, item.itemId, { rayaBatchId: existingBatchId });
    }
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'batch_already_created',
      resumed: unresolved.length,
    });
    return;
  }

  const content = parseVoiceContent(job.content);
  const resolvedRows = await decryptVoiceItems(job, deps, voice, content.variables);

  const contacts: VoiceContact[] = [];
  for (const row of resolvedRows) {
    const phone = row.contact?.phone?.value;
    if (!phone || phone.trim().length === 0) {
      await deps.client.markItem(job.id, row.item_id, 'skipped_no_contact', 'no_phone');
      continue;
    }
    contacts.push({
      ref: row.item_id,
      name: row.contact?.name?.value ?? '',
      phone,
      variables: flattenVariables(row.item_state),
    });
  }

  if (contacts.length === 0) {
    // Every resolved item lacked a phone (or nothing was owned) — the marks
    // above already account for them; the roll-up derives the job status.
    deps.log.warn({ ...base, status: 'skipped', reason: 'no_contactable_items', dispatched: 0 });
    return;
  }

  const result = await voice.provider.dispatch({
    agentRef: content.agent_id,
    batchName: content.batch_name ?? `campaign-${job.id}`,
    contacts,
    startOptions: voiceStartOptions(content),
  });
  if (!result.success) {
    await handleDispatchFailure(job, deps, contacts, result.error, base);
    return;
  }

  await deps.client.setProviderResponse(job.id, result.value.providerResponse);
  for (const ref of result.value.accepted) {
    await deps.client.markSubmitted(job.id, ref, { rayaBatchId: result.value.providerBatchRef });
  }
  for (const rejection of result.value.rejected) {
    await deps.client.markItem(job.id, rejection.ref, 'failed', rejection.error);
  }

  deps.log.info({
    ...base,
    status: 'success',
    dispatched: contacts.length,
    accepted: result.value.accepted.length,
    rejected: result.value.rejected.length,
  });
}
