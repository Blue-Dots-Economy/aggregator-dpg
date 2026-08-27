/**
 * Raya HTTP adapter for the campaign voice channel (aggregator-dpg#577).
 *
 * Concrete {@link VoiceProviderBase} implementation. `dispatch()` is a
 * two-step call against the Raya batch-calling API: `POST /batch` creates
 * the batch and validates each contact row, then (only if at least one
 * contact was accepted) `POST /batch/{batchId}/start` kicks off dialling.
 * Not exported from the package barrel directly — external packages obtain
 * an instance exclusively via {@link getVoiceProvider} in `./index.js`, per
 * the base-class-pattern rule (concrete providers live behind the factory,
 * never imported by module path).
 *
 * HTTP retry/timeout/typed-error shape is modelled on
 * `packages/signalstack-writer/src/http.ts`, with one addition: a `429`
 * honours Raya's own signalled wait instead of the computed exponential
 * backoff. Per Raya's actual `RateLimitError`/`ConcurrencyLimitError` shape
 * that wait rides the JSON response body as `retry_after` (seconds) — Raya
 * does NOT send an HTTP `Retry-After` header — so the body field is tried
 * first, with the header kept only as a defensive fallback should that ever
 * change.
 *
 * `providerResponse` (persisted verbatim by the worker onto
 * `campaign_job.provider_response` — a durable, campaign-manager-visible
 * column) is built from a **curated whitelist**, never the raw upstream
 * payload: Raya's real `POST /batch` response echoes the offending value
 * back in `errors[].value` (a raw phone/name) and echoes `data[]` (the
 * submitted contact rows) — both PII. {@link curateCreateResponse} and
 * {@link curateStartResponse} strip everything outside their whitelist
 * before it ever reaches {@link VoiceDispatchResult.providerResponse}; the
 * type-level {@link CuratedProviderResponse} brand (declared in
 * `./interface.js`) makes this a compile-time guarantee, not just a
 * convention — only these two curation helpers can produce a value typed to
 * fit `VoiceDispatchResult.providerResponse`.
 *
 * `dispatch()` also (1) — ONLY when the caller signals a retry via
 * `input.reuseExisting` — looks up an existing batch by deterministic name
 * before creating one, reusing it instead of minting a duplicate on a
 * transient start-failure retry (see the I4 note on {@link dispatch}; the
 * lookup is skipped outright on a first attempt, where it can only ever
 * return "not found" but would still cost a full egress-gated round trip),
 * and (2) never reports more contacts as `accepted` than Raya itself confirms —
 * an unmappable `errors[].row` or an accepted count exceeding
 * `contactsInserted`/`validRows` demotes the excess to `rejected` rather
 * than silently over-reporting success (see the I5 note on
 * {@link splitAcceptedRejected}).
 *
 * @module @aggregator-dpg/voice-provider
 */

import {
  AuthError,
  UpstreamError,
  ValidationError,
} from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { stripTrailingSlashes } from '@aggregator-dpg/shared-primitives/url';

import {
  VoiceProviderBase,
  brandCuratedProviderResponse,
  type CuratedProviderResponse,
  type VoiceDispatchInput,
  type VoiceDispatchResult,
} from './interface.js';

/**
 * Raya's `POST /batch` response shape (only the fields this adapter reads).
 * `errors[].value` (the raw rejected phone/name) and `data[]` (an echo of the
 * submitted contact rows) are read for accept/reject bookkeeping only — see
 * {@link curateCreateResponse} for what actually gets persisted.
 */
interface RayaCreateBatchResponse {
  status?: unknown;
  message?: unknown;
  batchId?: unknown;
  totalRows?: unknown;
  validRows?: unknown;
  invalidRows?: unknown;
  contactsInserted?: unknown;
  errors?: Array<{ row?: unknown; field?: unknown; value?: unknown; message?: unknown }>;
  data?: unknown;
}

/** Raya's `POST /batch/{id}/start` response shape (only the fields this adapter reads). */
interface RayaStartBatchResponse {
  id?: unknown;
  status?: unknown;
  total_contacts?: unknown;
  completed_contacts?: unknown;
  unanswered_contacts?: unknown;
  schedule?: unknown;
  max_retries?: unknown;
  concurrency?: unknown;
  retry_after_hrs?: unknown;
}

/**
 * Raya's `GET /batch` (list batches) response shape (only the fields this
 * adapter reads) — used by {@link RayaVoiceProvider.findExistingBatch} (I4)
 * to detect a batch a prior, transiently-failed attempt already created.
 */
interface RayaListBatchesResponse {
  batches?: Array<{ id?: unknown; name?: unknown; agent_id?: unknown; total_contacts?: unknown }>;
}

/**
 * Whitelist of `POST /batch` response fields safe to persist. Deliberately
 * excludes `errors` (carries `errors[].value`, the raw rejected phone/name)
 * and `data` (echoes the submitted contact rows) — see the module note.
 */
const CREATE_RESPONSE_PERSIST_KEYS = [
  'status',
  'message',
  'totalRows',
  'validRows',
  'invalidRows',
  'batchId',
  'contactsInserted',
] as const satisfies readonly (keyof RayaCreateBatchResponse)[];

/** Whitelist of `POST /batch/{id}/start` response fields safe to persist. */
const START_RESPONSE_PERSIST_KEYS = [
  'id',
  'status',
  'total_contacts',
  'completed_contacts',
  'unanswered_contacts',
  'schedule',
  'max_retries',
  'concurrency',
  'retry_after_hrs',
] as const satisfies readonly (keyof RayaStartBatchResponse)[];

/**
 * Curates the raw `POST /batch` response down to the persistence whitelist —
 * never the full payload (see the module note on why `errors`/`data` are PII).
 *
 * @param payload - The raw parsed create-response body.
 * @returns Only the whitelisted fields present on `payload`, branded {@link CuratedProviderResponse}.
 */
function curateCreateResponse(payload: RayaCreateBatchResponse): CuratedProviderResponse {
  const out: Record<string, unknown> = {};
  for (const key of CREATE_RESPONSE_PERSIST_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return brandCuratedProviderResponse(out);
}

/**
 * Curates the raw `POST /batch/{id}/start` response down to the persistence
 * whitelist. `payload` is typed `unknown` at the call site (Raya's start
 * response isn't otherwise parsed) so this validates shape defensively.
 *
 * @param payload - The raw parsed start-response body.
 * @returns Only the whitelisted fields present on `payload` (or `{}` if
 *   `payload` isn't an object), branded {@link CuratedProviderResponse}.
 */
function curateStartResponse(payload: unknown): CuratedProviderResponse {
  const out: Record<string, unknown> = {};
  if (payload !== null && typeof payload === 'object') {
    const record = payload as RayaStartBatchResponse;
    for (const key of START_RESPONSE_PERSIST_KEYS) {
      if (record[key] !== undefined) out[key] = record[key];
    }
  }
  return brandCuratedProviderResponse(out);
}

/** Configuration for {@link RayaVoiceProvider}. */
export interface RayaVoiceProviderOptions {
  /** Base URL of the Raya API, e.g. `https://raya.example.com/api`. No trailing slash required. */
  baseUrl: string;
  /** Raya API key, sent as `X-API-Key` on every request. */
  apiKey: string;
  /** Optional per-attempt request timeout in ms; off by default. */
  timeoutMs?: number;
  /**
   * Max total attempts per HTTP call (create or start) before giving up.
   * `3` by default (1 initial attempt + 2 retries). Retries cover transport
   * errors, request timeouts, `429`, and `5xx`; a non-`429` `4xx` is never
   * retried.
   */
  maxAttempts?: number;
  /**
   * Rate-limit gate the caller must await before every create/start call
   * (see `./egress.js`'s `acquireRayaSlot`). Injected so this adapter has
   * no direct Redis dependency and stays unit-testable.
   */
  acquireSlot: () => Promise<void>;
  /** Optional override; defaults to global `fetch`. Lets tests inject a stub. */
  fetchImpl?: typeof fetch;
  /**
   * Sleep function used for retry backoff (including a `429`'s signalled
   * wait); defaults to a real `setTimeout`-backed wait. Injectable so tests
   * can assert the exact computed delay without a real wall-clock wait.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class RayaVoiceProvider extends VoiceProviderBase {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number | undefined;
  private readonly maxAttempts: number;
  private readonly acquireSlot: () => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RayaVoiceProviderOptions) {
    super();
    if (!opts.baseUrl) throw new Error('RayaVoiceProvider requires baseUrl');
    if (!opts.apiKey) throw new Error('RayaVoiceProvider requires apiKey');
    if (!opts.acquireSlot) throw new Error('RayaVoiceProvider requires acquireSlot');
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.acquireSlot = opts.acquireSlot;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Creates a Raya batch from `input.contacts` (or reuses one, per I4 below),
   * then starts it — unless every contact was rejected/demoted, in which
   * case `start` is skipped entirely and `providerResponse.start` is `null`.
   *
   * I4: when `input.reuseExisting` is true (the caller's signal that this is
   * a BullMQ retry, not a first attempt), looks up an existing batch with
   * the same deterministic `input.batchName` for this agent via
   * {@link findExistingBatch} before creating. `dispatch()` is two
   * non-atomic HTTP calls (create, then start) with no client idempotency
   * key — if a prior attempt got a successful create but then hit a
   * transient start failure (5xx, timeout), a naive retry would call create
   * again and mint a second, orphaned batch at Raya while duplicate-dialling
   * the same contacts. A hit reuses that batch's id and skips create
   * entirely.
   *
   * The lookup is SKIPPED (not just best-effort-swallowed) when
   * `reuseExisting` is falsy — i.e. on every first attempt, the
   * overwhelming majority of calls. On a first attempt no batch under this
   * deterministic name can exist yet (the name embeds the job id, which is
   * unique), so the lookup can only ever return "not found" there; paying
   * its egress-gated latency (a 3rd `acquireSlot()` wait) on that path would
   * roughly double the happy-path dispatch latency to guard a retry-only
   * crash window. The item-level `providerBatchRef` resume guard in the
   * worker's `voice.ts` already covers the create→first-`markSubmitted`
   * crash window on retries independently of this lookup.
   *
   * @param input - The batch definition (agent, name, contacts, start
   *   options, and the `reuseExisting` retry hint).
   * @returns Ok with the provider batch reference and per-contact
   *   accept/reject outcome, or Err if the create call itself failed (auth,
   *   validation, or an exhausted-retry upstream/transport failure).
   */
  override async dispatch(
    input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    const existing = input.reuseExisting
      ? await this.findExistingBatch(input.agentRef, input.batchName)
      : undefined;

    let providerBatchRef: string;
    let accepted: string[];
    let rejected: { ref: string; error: string }[];
    let createResponse: CuratedProviderResponse;

    if (existing) {
      providerBatchRef = String(existing.batchId);
      const demoted: { ref: string; error: string }[] = [];
      // I5: we have no per-contact accept/reject detail from the reused
      // batch's (now-unavailable) original create response — only its
      // confirmed `total_contacts`. Never claim more contacts succeeded than
      // that: demote the tail beyond it, same as the short-count guard below.
      accepted = demoteExcess(
        input.contacts.map((c) => c.ref),
        existing.totalContacts,
        'raya_batch_reused_short_count',
        demoted,
      );
      rejected = demoted;
      createResponse = brandCuratedProviderResponse({
        status: 'reused',
        message: 'existing batch reused after a transient start-call retry',
        batchId: existing.batchId,
        contactsInserted: existing.totalContacts,
      });
    } else {
      await this.acquireSlot();
      const createResult = await this.request<RayaCreateBatchResponse>('POST', '/batch', {
        agent_id: input.agentRef,
        batch_name: input.batchName,
        contacts: input.contacts.map((c) => ({
          contact_name: c.name,
          contact_phone: c.phone,
          ...(c.countryCode ? { country_code: c.countryCode } : {}),
          ref: c.ref,
          ...c.variables,
        })),
      });
      if (!createResult.success) return err(createResult.error);
      const createPayload = createResult.value;

      if (typeof createPayload.batchId !== 'number') {
        return err(
          new UpstreamError('raya batch create returned unexpected payload', {
            code: 'RAYA_BAD_RESPONSE',
            details: { payload: createPayload },
          }),
        );
      }
      providerBatchRef = String(createPayload.batchId);
      ({ accepted, rejected } = this.splitAcceptedRejected(input, createPayload));
      createResponse = curateCreateResponse(createPayload);
    }

    if (accepted.length === 0) {
      return ok({
        providerBatchRef,
        accepted,
        rejected,
        providerResponse: { create: createResponse, start: null },
      });
    }

    // Forward only the caller-supplied startOptions keys verbatim (Raya's
    // start endpoint accepts `schedule`, `max_retries`, `retry_after_hrs`,
    // `max_concurrent_calls`, `selected_statuses`) — omit undefined-valued
    // keys, inject no defaults. A 400 from Raya because it required a field
    // the caller didn't send surfaces as ValidationError, not a silently
    // defaulted request.
    await this.acquireSlot();
    const startBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.startOptions)) {
      if (value !== undefined) startBody[key] = value;
    }
    const startResult = await this.request<unknown>(
      'POST',
      `/batch/${providerBatchRef}/start`,
      startBody,
    );
    if (!startResult.success) return err(startResult.error);

    return ok({
      providerBatchRef,
      accepted,
      rejected,
      providerResponse: {
        create: createResponse,
        start: curateStartResponse(startResult.value),
      },
    });
  }

  /**
   * Looks up an already-created batch with the same deterministic name for
   * this agent, via Raya's `GET /api/batch` (list batches) endpoint — see
   * the I4 note on {@link dispatch}. That endpoint scopes results to one
   * `agent_id` server-side but has no server-side name filter, so this
   * fetches (newest-first, capped at 100 — the deterministic name is unique
   * per job, so a match should be recent) and filters client-side by exact
   * name match.
   *
   * Best-effort: if the list call itself fails (network, exhausted retries,
   * unexpected shape), that's treated the same as "not found" rather than
   * failing the whole dispatch — this lookup is a duplicate-avoidance
   * optimisation layered on top of create+start, not a precondition for it.
   *
   * @param agentRef - The agent this batch belongs to.
   * @param batchName - The deterministic batch name (`campaign-{job.id}`) to match.
   * @returns The matching batch's id + confirmed contact count, or
   *   `undefined` if none was found (including when the lookup itself failed).
   */
  private async findExistingBatch(
    agentRef: string,
    batchName: string,
  ): Promise<{ batchId: number; totalContacts: number } | undefined> {
    await this.acquireSlot();
    const result = await this.request<RayaListBatchesResponse>(
      'GET',
      `/batch?agent_id=${encodeURIComponent(agentRef)}&limit=100&sort=desc`,
      undefined,
    );
    if (!result.success) return undefined;
    const batches = Array.isArray(result.value.batches) ? result.value.batches : [];
    // The `agent_id` query param already scopes this server-side; the
    // client-side check is a defensive belt-and-braces guard, not a
    // substitute for it.
    const match = batches.find((b) => b.name === batchName && b.agent_id === agentRef);
    if (!match || typeof match.id !== 'number') return undefined;
    const totalContacts = typeof match.total_contacts === 'number' ? match.total_contacts : 0;
    return { batchId: match.id, totalContacts };
  }

  /**
   * Maps Raya's 1-based `errors[].row` back to the originating contact's
   * `ref`, then cross-checks the resulting accepted count against Raya's own
   * declared counts (I5) — three ways a naive "everything not explicitly
   * rejected is accepted" default can over-report success, all guarded here:
   *
   *   1. A duplicate mapped row is only counted once (unchanged behaviour).
   *   2. An unmappable `errors[].row` (0/1-based drift, or a global/rowless
   *      error with no usable `row` at all) means Raya rejected something we
   *      can't attribute to a specific contact. Rather than silently letting
   *      those stay `accepted`, the tail of the accepted set (in dispatch
   *      order) is demoted with `raya_unmapped_rejection` — we can't know
   *      which contact(s) the unmapped error(s) actually refer to, so this is
   *      the least-bad conservative choice: never claim more contacts
   *      succeeded than Raya's own error count allows.
   *   3. The accepted count still exceeds Raya's own `contactsInserted` (or
   *      `validRows`, if `contactsInserted` is absent) — demoted with
   *      `raya_short_count`.
   *
   * @param input - The dispatch input whose `contacts` order the rows index into.
   * @param payload - Raya's create-response payload (`errors`, `contactsInserted`, `validRows`).
   * @returns The accepted vs. rejected contact refs.
   */
  private splitAcceptedRejected(
    input: VoiceDispatchInput,
    payload: RayaCreateBatchResponse,
  ): { accepted: string[]; rejected: { ref: string; error: string }[] } {
    const rejectedRefs = new Set<string>();
    const rejected: { ref: string; error: string }[] = [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    let unmappedCount = 0;
    for (const e of errors) {
      const row = typeof e.row === 'number' ? e.row : undefined;
      if (row === undefined || row < 1 || row > input.contacts.length) {
        unmappedCount += 1;
        continue;
      }
      const contact = input.contacts[row - 1];
      if (!contact || rejectedRefs.has(contact.ref)) continue;
      rejectedRefs.add(contact.ref);
      rejected.push({ ref: contact.ref, error: resolveRejectionReason(e) });
    }

    let accepted = input.contacts.map((c) => c.ref).filter((ref) => !rejectedRefs.has(ref));

    if (unmappedCount > 0) {
      accepted = demoteExcess(
        accepted,
        accepted.length - unmappedCount,
        'raya_unmapped_rejection',
        rejected,
      );
    }

    const declaredAccepted = firstFiniteNumber(payload.contactsInserted, payload.validRows);
    if (declaredAccepted !== undefined) {
      accepted = demoteExcess(accepted, declaredAccepted, 'raya_short_count', rejected);
    }

    return { accepted, rejected };
  }

  /**
   * Performs one Raya API call with a per-attempt timeout and bounded
   * exponential-backoff retry of transient failures.
   *
   * Retries on: a thrown transport error, an aborted (timed-out) request,
   * and a `429` or `5xx` response — up to {@link maxAttempts} total tries. A
   * `429` honours Raya's signalled wait for the retry instead of the
   * computed backoff, when present — preferring the JSON body's
   * `retry_after` (seconds, Raya's actual `RateLimitError`/
   * `ConcurrencyLimitError` shape) and falling back to an HTTP `Retry-After`
   * header (see {@link resolveRetryAfterMs}). A `401` maps to
   * `AuthError` immediately (no retry — a bad key won't fix itself). Any
   * other `4xx` maps to `ValidationError` immediately (no retry — the
   * request itself is malformed). When every attempt is exhausted the
   * failure maps to `UpstreamError`. The per-attempt fetch and the
   * response classification are split into {@link attemptFetch} and
   * {@link classifyResponse} so this loop only orchestrates the retry
   * decision.
   *
   * @param method - HTTP method.
   * @param path - Path appended to `baseUrl` (leading slash).
   * @param body - JSON request body.
   * @returns ok(parsed JSON body) on 2xx; err(BaseError) otherwise.
   */
  private async request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Result<T, BaseError>> {
    const url = `${this.baseUrl}${path}`;
    let attemptsMade = 0;

    for (;;) {
      attemptsMade += 1;
      const attempt = await this.attemptFetch(method, url, body);

      if (!attempt.ok) {
        if (attemptsMade < this.maxAttempts) {
          await this.backoff(attemptsMade);
          continue;
        }
        return err(transportFailureError(path, this.timeoutMs, attempt));
      }

      const outcome = await classifyResponse<T>(attempt.res, path);
      if (outcome.kind === 'result') return outcome.result;

      // 429 or 5xx — transient, retry within budget.
      if (attemptsMade < this.maxAttempts) {
        await this.backoff(attemptsMade, outcome.retryAfterMs);
        continue;
      }
      return err(await exhaustedRetryError(path, attempt.res));
    }
  }

  /**
   * Issues one raw HTTP attempt with the per-attempt timeout, classifying a
   * thrown/aborted request separately from a received `Response` so
   * {@link request}'s retry loop doesn't have to.
   *
   * @param method - HTTP method.
   * @param url - Full request URL.
   * @param body - JSON request body.
   * @returns The `Response` on success, or the classified transport failure
   *   (including whether it was a timeout abort) on a thrown error.
   */
  private async attemptFetch(method: string, url: string, body: unknown): Promise<FetchAttempt> {
    const controller = this.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { ok: true, res };
    } catch (e) {
      const cause = e as Error;
      return { ok: false, aborted: cause.name === 'AbortError', cause };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Sleeps before the next retry attempt. Uses `overrideMs` (from a `429`'s
   * signalled wait) when given; otherwise `200ms * 2^(attempt-1)`.
   */
  private backoff(attempt: number, overrideMs?: number): Promise<void> {
    const ms = overrideMs ?? 200 * 2 ** (attempt - 1);
    if (ms <= 0) return Promise.resolve();
    return this.sleep(ms);
  }
}

/** Result of one raw `fetch` attempt inside {@link RayaVoiceProvider.request}'s retry loop. */
type FetchAttempt = { ok: true; res: Response } | { ok: false; aborted: boolean; cause: Error };

/** How {@link classifyResponse} tells {@link RayaVoiceProvider.request}'s retry loop what to do next. */
type ResponseOutcome<T> =
  { kind: 'result'; result: Result<T, BaseError> } | { kind: 'retry'; retryAfterMs?: number };

/**
 * Classifies one received `Response` from a Raya call: a 2xx parses to
 * `ok`, a `401` maps to `AuthError`, any other non-`429` `4xx` maps to
 * `ValidationError` — none of these are retried. A `429`/`5xx` is reported
 * back as `{ kind: 'retry' }` (with the `429`'s signalled wait, if any) and
 * left for the caller to decide whether attempts remain.
 *
 * @param res - The response to classify.
 * @param path - The request path, for error messages.
 * @returns Either the terminal `Result` to return, or a retry signal.
 */
async function classifyResponse<T>(res: Response, path: string): Promise<ResponseOutcome<T>> {
  if (res.ok) {
    try {
      return { kind: 'result', result: ok((await res.json()) as T) };
    } catch (e) {
      return {
        kind: 'result',
        result: err(
          new UpstreamError('raya returned a malformed JSON body', {
            cause: e,
            code: 'RAYA_BAD_RESPONSE',
          }),
        ),
      };
    }
  }

  if (res.status === 401) {
    const bodyText = await safeReadText(res);
    return {
      kind: 'result',
      result: err(
        new AuthError(`raya ${path} returned 401`, {
          code: 'RAYA_UNAUTHORIZED',
          details: { status: res.status, body: bodyText },
        }),
      ),
    };
  }

  if (res.status !== 429 && res.status < 500) {
    const bodyText = await safeReadText(res);
    return {
      kind: 'result',
      result: err(
        new ValidationError(`raya ${path} returned ${res.status}`, {
          code: 'RAYA_BAD_REQUEST',
          details: { status: res.status, body: bodyText },
        }),
      ),
    };
  }

  // 429 or 5xx — transient; the caller decides whether attempts remain.
  const retryAfterMs = res.status === 429 ? await resolveRetryAfterMs(res) : undefined;
  return retryAfterMs !== undefined ? { kind: 'retry', retryAfterMs } : { kind: 'retry' };
}

/**
 * Builds the `UpstreamError` for a thrown/aborted fetch once retries are
 * exhausted.
 *
 * @param path - The request path, for the error message.
 * @param timeoutMs - The configured per-attempt timeout, for the message text.
 * @param attempt - The failed attempt's classification.
 */
function transportFailureError(
  path: string,
  timeoutMs: number | undefined,
  attempt: { aborted: boolean; cause: Error },
): UpstreamError {
  return new UpstreamError(
    attempt.aborted
      ? `raya ${path} timed out after ${timeoutMs}ms`
      : `raya ${path} transport failure: ${attempt.cause.message}`,
    { cause: attempt.cause, code: attempt.aborted ? 'RAYA_TIMEOUT' : 'RAYA_TRANSPORT_FAILED' },
  );
}

/**
 * Builds the `UpstreamError` for a `429`/`5xx` response once retries are
 * exhausted.
 *
 * @param path - The request path, for the error message.
 * @param res - The final failed response.
 */
async function exhaustedRetryError(path: string, res: Response): Promise<UpstreamError> {
  const bodyText = await safeReadText(res);
  return new UpstreamError(`raya ${path} returned ${res.status}`, {
    code: 'RAYA_UPSTREAM_ERROR',
    details: { status: res.status, body: bodyText },
  });
}

/**
 * Resolves the rejection reason text for one Raya `POST /batch` `errors[]`
 * entry — extracted from a nested ternary so each branch is independently
 * named. Prefers `message`, falls back to `field`, then a generic default.
 *
 * @param e - One entry from Raya's create-response `errors` array.
 * @returns The reason string to store for the rejected contact.
 */
function resolveRejectionReason(e: { field?: unknown; message?: unknown }): string {
  if (typeof e.message === 'string') return e.message;
  if (typeof e.field === 'string') return e.field;
  return 'rejected';
}

/**
 * Moves the tail of `acceptedRefs` beyond `allowedCount` into `rejected`
 * (with `reason`), mutating `rejected` in place. Shared by
 * {@link RayaVoiceProvider.splitAcceptedRejected}'s two I5 demotion checks
 * and {@link RayaVoiceProvider.dispatch}'s I4 batch-reuse path — never
 * silently over-report `accepted` when the count can't be reconciled
 * against what Raya itself confirms.
 *
 * @param acceptedRefs - The currently-accepted contact refs, in dispatch order.
 * @param allowedCount - The maximum count that may legitimately stay accepted.
 * @param reason - The rejection reason recorded for any demoted ref.
 * @param rejected - Rejected-list accumulator; demoted refs are pushed here.
 * @returns The (possibly shortened) accepted list.
 */
function demoteExcess(
  acceptedRefs: string[],
  allowedCount: number,
  reason: string,
  rejected: { ref: string; error: string }[],
): string[] {
  const safeAllowed = Math.max(0, allowedCount);
  if (acceptedRefs.length <= safeAllowed) return acceptedRefs;
  for (const ref of acceptedRefs.slice(safeAllowed)) {
    rejected.push({ ref, error: reason });
  }
  return acceptedRefs.slice(0, safeAllowed);
}

/**
 * Returns the first finite number among `values`, or `undefined` if none
 * qualifies — used to prefer `contactsInserted` over `validRows` (or fall
 * back) without a chain of individual type guards at each call site.
 *
 * @param values - Candidate values, tried in order.
 */
function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Default sleep implementation — a real `setTimeout`-backed wait, used when
 * no `sleep` dependency is injected (i.e. outside of tests). Mirrors
 * `./egress.js`'s `defaultSleep`.
 *
 * @param ms - Milliseconds to wait.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves how long to wait before retrying a `429`, in ms.
 *
 * Prefers the JSON response body's `retry_after` field (seconds) — Raya's
 * actual `RateLimitError`/`ConcurrencyLimitError` shape carries the wait
 * there, and Raya does NOT send an HTTP `Retry-After` header. The header is
 * checked only as a defensive fallback (e.g. a future Raya version, or an
 * intermediary proxy adding one), and only when the body carried no usable
 * `retry_after`. Returns `undefined` — falling through to the computed
 * exponential backoff — when neither source yields a valid non-negative
 * number.
 *
 * Consumes the response body (`res.text()`); callers must not read the body
 * again from this `Response` afterwards.
 *
 * @param res - The `429` response.
 * @returns The wait in ms, or `undefined` to use the computed backoff.
 */
async function resolveRetryAfterMs(res: Response): Promise<number | undefined> {
  try {
    const bodyText = await res.text();
    if (bodyText) {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const bodySeconds = parsed?.['retry_after'];
      if (typeof bodySeconds === 'number' && Number.isFinite(bodySeconds) && bodySeconds >= 0) {
        return bodySeconds * 1000;
      }
    }
  } catch {
    // Non-JSON or unreadable body — fall through to the header fallback.
  }
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
