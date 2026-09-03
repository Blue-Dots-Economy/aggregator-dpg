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
 * Bound (ms) shared by both layers that keep an audit write from stalling a
 * request (#617 SHOULD-FIX 1): the real Postgres `SET LOCAL statement_timeout`
 * wrapped around the insert (so the DB itself cancels a stuck query and frees
 * the pooled connection), and the {@link safeAudit} `Promise.race` (a second,
 * belt-and-suspenders layer that also bounds any non-query stall, e.g. a slow
 * `await` before the query is even issued). Defined once so the two layers
 * can't drift apart.
 */
const CAMPAIGN_AUDIT_TIMEOUT_MS = 2000;

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
  writer ??= new PostgresCampaignAuditWriter(getDb(), CAMPAIGN_AUDIT_TIMEOUT_MS);
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
 * process shutdown and would surface only as an unhandled rejection. Bounding
 * the stall is TWO layers, not one (#617 SHOULD-FIX 1):
 *
 * 1. The writer itself wraps its insert in `SET LOCAL statement_timeout`
 *    (`PostgresCampaignAuditWriter`, constructed with `CAMPAIGN_AUDIT_TIMEOUT_MS`
 *    here). This is the layer that matters for a DB-side stall (e.g. something
 *    holding an exclusive lock on `campaign_pii_audit`): Postgres itself
 *    cancels the query and the pooled connection is released back to the
 *    pool. A `Promise.race` alone cannot do this — it only makes the *caller*
 *    stop waiting; the query and its checked-out connection keep running
 *    underneath.
 * 2. This function's own `Promise.race` against `timeoutMs` is a second,
 *    belt-and-suspenders layer that also bounds any non-query stall (e.g. a
 *    slow `await` before the query is even issued, or a writer that doesn't
 *    use `PostgresCampaignAuditWriter`'s timeout at all, like the in-memory
 *    test fake).
 *
 * Both of the writer's failure modes are handled and neither is ever
 * rethrown: a thrown exception (e.g. the in-memory test fake's `failWith`, or
 * the race's own timeout) is caught, and a resolved `err(BaseError)` Result
 * (the Postgres writer's normal failure path — an insert failure there does
 * not throw) is detected from the settled value. Both are logged at `error`
 * with the supplied context. The race's timer is always cleared in `finally`,
 * win or lose, so a settled audit write never leaves a live timer behind.
 *
 * @param fn - Thunk that performs the audit write (a `recordX` call on the
 *   process-wide writer).
 * @param ctx - Structured-log context identifying which write this was.
 * @param timeoutMs - Max time to wait before giving up on the write and
 *   logging a timeout failure (default {@link CAMPAIGN_AUDIT_TIMEOUT_MS}).
 */
export async function safeAudit(
  fn: () => Promise<Result<void, BaseError>>,
  ctx: SafeAuditContext,
  timeoutMs = CAMPAIGN_AUDIT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<Result<void, BaseError>>((_, reject) => {
        timer = setTimeout(() => reject(new Error('audit write timed out')), timeoutMs);
      }),
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
  } finally {
    // The losing side of the race (usually the timer, since the DB-side
    // statement timeout is what actually bounds a stuck query) must not be
    // left running — an uncleared timer keeps the event loop alive and can
    // make process shutdown linger (#617 cheap item).
    clearTimeout(timer);
  }
}
