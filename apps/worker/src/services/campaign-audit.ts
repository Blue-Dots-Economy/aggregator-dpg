/**
 * Worker-side audit writer accessor (#617). Mirrors the API's
 * `apps/api/src/services/campaign-audit/index.ts`, against the worker's own
 * database handle — the worker writes the `completed` row once a campaign job
 * reaches a terminal status (see `./campaign-process/index.ts`'s
 * `runCampaignJob`), and also from the stalled-job sweep
 * (`../jobs/cron-watchdog.ts`) when a job is force-failed for a stale
 * heartbeat.
 *
 * @module @aggregator-dpg/worker
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { getDb } from '../db.js';

let writer: CampaignAuditWriterBase | null = null;

/**
 * Returns the process-wide {@link CampaignAuditWriterBase}, lazily
 * constructing the Postgres-backed implementation (writing to
 * `campaign_pii_audit`) on first use.
 *
 * `getDb()` (a `NodePgDatabase<typeof schema>`) is passed to
 * `PostgresCampaignAuditWriter` with no cast: it satisfies `AuditDb`
 * structurally now that the writer's insert seam is typed against
 * `campaignPiiAudit.$inferInsert` (#617 review-round-2) rather than
 * `unknown` — an `as never` here previously erased that check.
 *
 * @returns The singleton audit writer.
 */
export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  writer ??= new PostgresCampaignAuditWriter(getDb());
  return writer;
}

/**
 * Test seam — installs a replacement audit writer (typically
 * `CampaignAuditWriterFake` from `@aggregator-dpg/campaign-audit/testing`),
 * or clears the override.
 *
 * @param w - The writer to install, or `null` to reset so the next
 *   {@link getCampaignAuditWriter} call rebuilds the real Postgres-backed
 *   singleton.
 */
export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}

/** Minimal logger surface {@link safeAudit} needs — satisfied by a pino child or a test stub. */
export interface SafeAuditLogger {
  error(obj: object): void;
}

/** Structured-log context a {@link safeAudit} call site supplies, for the error line it may emit. */
export interface SafeAuditContext {
  /** `operation` field on the emitted log line, e.g. `campaignAudit.completed`. */
  operation: string;
  /** The `campaign_job.id` this write is for. */
  job_id: string;
  /** The audited channel. */
  channel: string;
}

/**
 * Runs an audit write so it can never affect the caller (#617).
 *
 * No timeout here, unlike the API's `safeAudit`
 * (`apps/api/src/services/campaign-audit/index.ts`): by the time any worker
 * call site reaches this helper the triggering operation has already reached
 * a terminal state — there is no HTTP response waiting on the write.
 *
 * Handles BOTH of the writer's failure modes — code that only handles one is
 * blind to the other in production:
 * - a thrown exception (e.g. the in-memory test fake's `failWith`, or a
 *   collaborator error thrown before the writer even returns a `Result`);
 * - a resolved `err(BaseError)` Result (`PostgresCampaignAuditWriter`'s
 *   normal failure path — an insert failure there does not throw).
 *
 * Neither is ever rethrown; both are logged at `error` with the supplied
 * context. Shared by `campaign-process/index.ts` (the per-job terminal
 * write) and `jobs/cron-watchdog.ts` (the stalled-job sweep) so the two
 * error-handling paths cannot drift.
 *
 * @param fn - Thunk performing the audit write (a `recordX` call on the
 *   process-wide writer). May resolve `undefined` when no writer is
 *   configured — treated as a no-op success.
 * @param log - Structured logger to emit the failure line on.
 * @param ctx - Structured-log context identifying which write this was.
 */
export async function safeAudit(
  fn: () => Promise<Result<void, BaseError> | undefined>,
  log: SafeAuditLogger,
  ctx: SafeAuditContext,
): Promise<void> {
  try {
    const result = await fn();
    if (result && !result.success) {
      log.error({ ...ctx, status: 'failure', error: result.error.message });
    }
  } catch (cause) {
    log.error({
      ...ctx,
      status: 'failure',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
