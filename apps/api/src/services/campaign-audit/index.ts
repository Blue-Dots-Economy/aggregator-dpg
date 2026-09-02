/**
 * Process-wide campaign-PII-audit writer accessor, plus the best-effort
 * wrapper every call site (#617 Tasks 5-7) uses to record an audit row.
 *
 * Audit failures NEVER fail a campaign or delay a response unreasonably
 * (#617). Every write this module performs happens after the triggering
 * operation is already durable — the job is committed and enqueued, or (for
 * the dump route) the response has already been prepared — so nothing this
 * module does can prevent that operation from proceeding, and a failure here
 * is observability, not control flow.
 *
 * @module @aggregator-dpg/api
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { AuditChannel, CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { getDb } from '../../db/client.js';
import { logger } from '../../logger.js';

let writer: CampaignAuditWriterBase | null = null;

/**
 * Returns the process-wide {@link CampaignAuditWriterBase}, lazily
 * constructing the Postgres-backed implementation (writing to
 * `campaign_pii_audit`) on first use.
 *
 * @returns The singleton audit writer.
 */
export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  if (!writer) writer = new PostgresCampaignAuditWriter(getDb() as never);
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

/** Structured-log context a {@link safeAudit} call site supplies, for the error line it may emit. */
export interface SafeAuditContext {
  /** `operation` field on the emitted log line, e.g. `campaignAudit.requested`. */
  operation: string;
  /** The job id (or a generated id for the synchronous dump route) this write is for. */
  correlation_id: string;
  /** The audited channel. */
  channel: AuditChannel;
}

/**
 * Runs an audit write so that nothing it does — success, failure, or a
 * stall — can affect the caller (#617).
 *
 * Awaited rather than fire-and-forget: an un-awaited promise can be lost on
 * process shutdown and would surface only as an unhandled rejection. It is
 * bounded by `timeoutMs` so a stall on this table can never hold an HTTP
 * response open. Both of the writer's failure modes are handled and neither
 * is ever rethrown: a thrown exception (e.g. the in-memory test fake's
 * `failWith`, or the race's own timeout) is caught, and a resolved
 * `err(BaseError)` Result (the Postgres writer's normal failure path — an
 * insert failure there does not throw) is detected from the settled value.
 * Both are logged at `error` with the supplied context.
 *
 * @param fn - Thunk that performs the audit write (a `recordX` call on the
 *   process-wide writer).
 * @param ctx - Structured-log context identifying which write this was.
 * @param timeoutMs - Max time to wait before giving up on the write and
 *   logging a timeout failure (default 2000ms).
 */
export async function safeAudit(
  fn: () => Promise<Result<void, BaseError>>,
  ctx: SafeAuditContext,
  timeoutMs = 2000,
): Promise<void> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<Result<void, BaseError>>((_, reject) =>
        setTimeout(() => reject(new Error('audit write timed out')), timeoutMs),
      ),
    ]);
    if (!result.success) {
      logger.error({ ...ctx, status: 'failure', error: result.error.message });
    }
  } catch (cause) {
    logger.error({
      ...ctx,
      status: 'failure',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
