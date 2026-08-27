/**
 * Unified campaign-process orchestrator (aggregator-dpg#579).
 *
 * Runs one durable `campaign_job` end-to-end: loads the job + its items, guards
 * against re-running an already-terminal job (BullMQ retry safety), marks the
 * job `processing`, dispatches to the per-channel handler, writes per-item
 * terminal status as it goes, and rolls the job status up from the item counts.
 *
 * The export channel is implemented here (decrypt → CSV → private S3 → email a
 * short-lived pre-signed link). The voice channel (aggregator-dpg#577)
 * dispatches through `./voice.js`'s `runVoiceForJob`. The email channel is
 * still a deliberate not-implemented stub — its PR (#578) fills it in on
 * this same engine.
 *
 * Failure semantics: a transient/infra failure (decrypt err(), the #521
 * contact-block guard, an S3 or mail rejection) re-throws so BullMQ retries and
 * the job is left `processing` — never falsely marked terminal. Per-item
 * "not found / not owned" is a terminal item failure (not a job failure); the
 * roll-up turns a mix into `partially_failed`. Never logs PII.
 * Belongs to `@aggregator-dpg/worker`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
  SignalStackDecryptedProfileRow,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { buildContactExportCsv, buildDecryptedProfilesCsv } from '@aggregator-dpg/profile-csv';
import type { SignedDownloadUrl } from '../../object-storage.js';
import { TERMINAL_JOB_STATUSES } from '../campaign-job-client.js';
import type {
  CampaignJobItemStatus,
  CampaignJobStatus,
  MarkSubmittedArgs,
  ProcessingJob,
} from '../campaign-job-client.js';
import { runVoiceForJob, type VoiceCollaborators } from './voice.js';

/** Minimal structured logger surface (satisfied by the worker's pino child). */
export interface CampaignLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** The subset of the job-client the orchestrator writes through. */
export interface CampaignJobClient {
  getJobForProcessing(jobId: string): Promise<ProcessingJob | null>;
  markItem(
    jobId: string,
    itemId: string,
    status: CampaignJobItemStatus,
    errorReason?: string,
  ): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  setJobStatus(jobId: string, status: CampaignJobStatus, errorReason?: string): Promise<void>;
  rollUpStatus(jobId: string): Promise<CampaignJobStatus>;
  /** Marks the job's user-visible notification as sent; a retry must not re-send. */
  setNotifiedAt(jobId: string): Promise<void>;
  /** Fails items still `pending` on a job that has run out of retries. */
  failPendingItems(jobId: string, errorReason: string): Promise<void>;
  /** Voice: records that an item was submitted to the voice provider (sets `submitted` + `raya_batch_id`). */
  markSubmitted(jobId: string, itemId: string, args: MarkSubmittedArgs): Promise<void>;
  /** Voice: stores the raw provider create+start response on the job, for the campaign manager to render. */
  setProviderResponse(jobId: string, response: unknown): Promise<void>;
}

/** Export collaborators (decrypt/storage/mail) — narrow so the job is trivially faked. */
export interface ExportCollaborators {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
}

export interface CampaignJobConfig {
  /** Items per decrypt chunk. */
  decryptChunk: number;
  /** `contact` = name/email/phone only; `full` = full item_state (variable columns). */
  fieldSet: 'contact' | 'full';
  /**
   * Who gets the export link: `requester` (the job's `requested_by`) or
   * `network_admin` (`networkAdminEmail`). Deployment-level, never caller-set.
   */
  recipientMode: 'requester' | 'network_admin';
  /** Recipient used when `recipientMode` is `network_admin`. */
  networkAdminEmail?: string;
}

export interface CampaignJobDeps {
  client: CampaignJobClient;
  export: ExportCollaborators;
  /** Voice-channel collaborators (decrypt + provider). Required only when `job.channel === 'voice'`. */
  voice?: VoiceCollaborators;
  config: CampaignJobConfig;
  log: CampaignLogger;
  /** Retry position, so the final attempt can record a terminal failure. */
  attempt?: { attempt: number; maxAttempts: number };
}

const TERMINAL_JOB = new Set<CampaignJobStatus>(TERMINAL_JOB_STATUSES);

/**
 * Keeps the head of an error message bounded. Shared across channel
 * handlers in this folder (export's job-level `error_reason`, voice's
 * item-level `error_reason`, which can otherwise carry an entire raw
 * provider response body).
 */
export function truncateReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

/**
 * Runs one campaign job by id.
 *
 * @param jobId - The `campaign_job.id` to process (trusted — from the queue).
 * @param deps - Injected job-client, export collaborators, config, logger.
 */
export async function runCampaignJob(jobId: string, deps: CampaignJobDeps): Promise<void> {
  const job = await deps.client.getJobForProcessing(jobId);
  if (!job) {
    deps.log.warn({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'job_not_found',
      job_id: jobId,
    });
    return;
  }
  // Retry guard: a job that already reached a terminal status is not re-run.
  if (TERMINAL_JOB.has(job.status)) {
    deps.log.info({
      operation: 'campaign.process',
      status: 'skipped',
      reason: 'already_terminal',
      job_id: jobId,
      job_status: job.status,
    });
    return;
  }

  await deps.client.setJobStatus(jobId, 'processing');

  try {
    if (job.channel === 'export') {
      await runExportForJob(job, deps);
    } else if (job.channel === 'voice') {
      await runVoiceForJob(job, deps);
    } else {
      // The email PR implements this on this same engine.
      throw new Error(`campaign channel not implemented: ${job.channel}`);
    }
    const status = await deps.client.rollUpStatus(jobId);
    deps.log.info({
      operation: 'campaign.process',
      status: 'success',
      job_id: jobId,
      channel: job.channel,
      job_status: status,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Unknown retry position (no `attempt` injected) is treated as NOT final:
    // marking a job terminal while BullMQ still has retries left would abandon
    // work that would otherwise have succeeded, so the guard fails safe.
    const attempt = deps.attempt;
    const isFinalAttempt = attempt !== undefined && attempt.attempt >= attempt.maxAttempts;

    deps.log.error({
      operation: 'campaign.process',
      status: 'failure',
      job_id: jobId,
      channel: job.channel,
      attempt: attempt?.attempt,
      max_attempts: attempt?.maxAttempts,
      final_attempt: isFinalAttempt,
      error: reason,
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
    });

    // Mid-sequence: leave the job `processing` so BullMQ retries it.
    // On the LAST attempt there is no retry coming, so leaving it `processing`
    // would strand it until the watchdog swept it with a generic `stalled`
    // reason — losing the actual cause. Record the real reason instead, and
    // resolve items still `pending` (never reached, so never marked) so the
    // derived counts add up to the requested total.
    if (isFinalAttempt) {
      await deps.client.failPendingItems(jobId, 'job_failed');
      await deps.client.setJobStatus(jobId, 'failed', truncateReason(reason));
    }
    throw err;
  }
}

/**
 * Decrypts the job's items in chunks, marking each resolved/failed and beating
 * the heartbeat per chunk. Re-throws on a transient decrypt failure or the #521
 * contact-block guard (so BullMQ retries). Returns the resolved profile rows.
 */
async function decryptAndMarkItems(
  job: ProcessingJob,
  deps: CampaignJobDeps,
  contactOnly: boolean,
): Promise<SignalStackDecryptedProfileRow[]> {
  const itemIds = job.items.map((i) => i.itemId);
  const resolvedRows: SignalStackDecryptedProfileRow[] = [];

  for (const chunk of chunkArray(itemIds, deps.config.decryptChunk)) {
    const query: SignalStackFetchDecryptedProfilesQuery = {
      actingOrgId: job.signalstackOrgId,
      itemIds: chunk,
      // contact-only projection: no item_state (fields:[]), just the canonical
      // contact fields with provenance (Signals #521). `full` omits `fields`.
      ...(contactOnly ? { fields: [], contact: ['name', 'email', 'phone'] } : {}),
      ...(job.requestId ? { requestId: job.requestId } : {}),
    };
    const result = await deps.export.fetchDecryptedProfiles(query);
    if (!result.success) {
      // Transient upstream failure — re-throw so BullMQ retries (items marked so
      // far persist; forward-only marks keep them on retry).
      throw new Error(
        `campaign export decrypt failed: ${result.error.code}: ${result.error.message}`,
      );
    }
    const { profiles, skipped } = result.value;

    // Cross-repo contract guard (Signals #521): a contact projection that comes
    // back with no contact block means an older Signals stripped it — fail loud
    // rather than ship an all-empty export.
    if (contactOnly && profiles.length > 0 && !profiles.some((p) => p.contact !== undefined)) {
      throw new Error(
        'campaign export decrypt returned no contact block — Signals participant/decrypt predates #521',
      );
    }

    for (const p of profiles) {
      resolvedRows.push(p);
      await deps.client.markItem(job.id, p.item_id, 'resolved');
    }
    for (const missing of skipped) {
      // Not a failure: the org simply doesn't own this item, so it is skipped
      // (and never leaked). Skips don't make the job `partial`.
      await deps.client.markItem(job.id, missing, 'skipped_not_owned', 'not_owned_by_org');
    }
    await deps.client.heartbeat(job.id);
  }
  return resolvedRows;
}

/** Runs the export channel for a job: chunked decrypt → item marks → CSV → S3 → email. */
async function runExportForJob(job: ProcessingJob, deps: CampaignJobDeps): Promise<void> {
  const contactOnly = deps.config.fieldSet === 'contact';
  const resolvedRows = await decryptAndMarkItems(job, deps, contactOnly);

  const base = {
    operation: 'campaign.export',
    job_id: job.id,
    org_id: job.signalstackOrgId,
    requested: job.items.length,
  };

  if (resolvedRows.length === 0) {
    // Nothing owned to export — every item was marked failed above; the roll-up
    // makes the job `failed`. No upload, no email. Counts only, never PII.
    deps.log.warn({ ...base, status: 'skipped', reason: 'no_resolvable_items', exported: 0 });
    return;
  }

  const csv = contactOnly
    ? buildContactExportCsv(resolvedRows)
    : buildDecryptedProfilesCsv(resolvedRows);
  // Deterministic per job: a retry overwrites the same object rather than
  // leaving an orphaned CSV of participant PII behind at a timestamped key
  // (which nothing would ever clean up before its lifecycle expiry).
  const key = `campaign-exports/${job.signalstackOrgId}/${job.id}.csv`;
  await deps.export.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.export.signDownloadUrl(key);

  const recipient =
    deps.config.recipientMode === 'network_admin' ? deps.config.networkAdminEmail : job.requestedBy;
  if (!recipient) {
    throw new Error(
      `campaign export has no recipient for mode "${deps.config.recipientMode}" ` +
        '(set EXPORT_NETWORK_ADMIN_EMAIL, or use CAMPAIGN_EXPORT_RECIPIENT=requester)',
    );
  }

  const email = renderExportEmail({
    orgId: job.signalstackOrgId,
    purpose: purposeOf(job) ?? '—',
    exported: resolvedRows.length,
    skipped: job.items.length - resolvedRows.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });
  // At-least-once delivery means a lost SMTP response leaves the job
  // `processing` and BullMQ retries it. Without this guard the requester would
  // get a SECOND working pre-signed link to the same participant PII.
  if (job.notifiedAt) {
    deps.log.info({
      ...base,
      status: 'skipped',
      reason: 'already_notified',
      exported: resolvedRows.length,
    });
    return;
  }

  const sent = await deps.export.sendMail({
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    // CSV is durably in S3; re-throw so BullMQ re-sends (re-decrypt + re-upload).
    throw new Error(`campaign export email failed: ${sent.error.code}: ${sent.error.message}`);
  }

  // Stamp before returning so a retry after this point cannot re-send.
  await deps.client.setNotifiedAt(job.id);

  deps.log.info({ ...base, status: 'success', exported: resolvedRows.length, s3_key: key });
}

/** Reads the `purpose` metadata pair off a job, if present. */
function purposeOf(job: ProcessingJob): string | undefined {
  const p = job.metadata.find((m) => m.key === 'purpose')?.value;
  return p?.trim() ? p : undefined;
}

/**
 * Splits an array into fixed-size chunks (never empty; last chunk may be
 * short). Shared across channel handlers in this folder (export + voice).
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Formats an ISO-8601 expiry timestamp for a human reader, in UTC — e.g.
 * `2026-08-13T06:13:34.191Z` → `13 Aug 2026, 06:13 UTC`. Falls back to the raw
 * value if it can't be parsed.
 */
function formatExpiry(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(when);
  return `${formatted} UTC`;
}

/** Renders the export-ready notification (link only — never the PII itself). */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.exported} records`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download it before ${formatExpiry(i.expiresAt)}:`,
    i.url,
    '',
    'After that the link stops working and the file is permanently deleted from storage — so download it now. The file contains personal data; do not forward this link.',
  ].join('\n');
  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    '<p>A participant PII export is ready.</p>',
    '<ul>',
    `<li>Requested by org: <strong>${esc(i.orgId)}</strong></li>`,
    `<li>Purpose: ${esc(i.purpose)}</li>`,
    `<li>Records exported: <strong>${i.exported}</strong></li>`,
    `<li>Skipped (not found / not owned): <strong>${i.skipped}</strong></li>`,
    '</ul>',
    `<p><a href="${esc(i.url)}">Download the export</a> before <strong>${formatExpiry(i.expiresAt)}</strong>.</p>`,
    '<p style="color:#a00">After that the link stops working and the file is <strong>permanently deleted</strong> from storage — so download it now. The file contains personal data; do not forward this link.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}
