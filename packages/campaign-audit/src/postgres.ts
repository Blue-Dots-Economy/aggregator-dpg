/**
 * Drizzle-backed audit writer.
 *
 * Only ever INSERTs. There is no update or delete here, and none should be
 * added — see the interface module doc.
 *
 * @module @aggregator-dpg/campaign-audit/postgres
 */
import { sql } from 'drizzle-orm';
import { campaignPiiAudit } from '@aggregator-dpg/db-schema/schema';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
  type DumpAuditInput,
} from './interface.js';

/** The subset of an insert builder this writer needs (shared by {@link AuditDb} and {@link AuditTx}). */
type AuditInsertable = (table: typeof campaignPiiAudit) => {
  values: (row: unknown) => Promise<unknown>;
};

/**
 * The transaction handle passed to the callback given to {@link AuditDb.transaction}.
 * Needs `execute` (to issue `SET LOCAL statement_timeout`) alongside `insert`.
 */
export interface AuditTx {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  insert: AuditInsertable;
}

/**
 * Minimal shape this writer needs — avoids coupling to a concrete Drizzle
 * client type. `transaction` is optional: it is only invoked when the writer
 * is constructed with a `statementTimeoutMs` (see the constructor), so a
 * caller (e.g. an existing unit-test stub) that only ever exercises the
 * no-timeout path never needs to implement it.
 */
export interface AuditDb {
  insert: AuditInsertable;
  transaction?: <T>(fn: (tx: AuditTx) => Promise<T>) => Promise<T>;
}

/**
 * {@link CampaignAuditWriterBase} implementation backed by the
 * `campaign_pii_audit` Postgres table via Drizzle.
 *
 * Every method funnels through the private {@link insert} helper, which is
 * the only place this class touches the database — there is deliberately no
 * update, delete, or read path anywhere in this class.
 */
export class PostgresCampaignAuditWriter extends CampaignAuditWriterBase {
  /**
   * @param db - Minimal Drizzle-like handle used only to INSERT rows into
   *   `campaign_pii_audit`.
   * @param statementTimeoutMs - When set, every insert runs inside a
   *   transaction with `SET LOCAL statement_timeout` pinned to this bound
   *   (#617 SHOULD-FIX 1). A `Promise.race` alone can only make the *caller*
   *   stop waiting — it does not cancel the in-flight query, so a stall (e.g.
   *   something holding an exclusive lock on this table) leaves the
   *   underlying pooled connection checked out indefinitely. A real
   *   statement timeout makes Postgres itself cancel the query, which is
   *   what actually frees the connection. Omit to insert directly with no
   *   per-statement bound (existing behaviour, still used by callers that
   *   don't need it, e.g. this package's own unit tests).
   */
  constructor(
    private readonly db: AuditDb,
    private readonly statementTimeoutMs?: number,
  ) {
    super();
  }

  /**
   * Inserts the `requested` row for a campaign action, at the moment the API
   * accepts it. `outcome` is deliberately never set here.
   *
   * @param input - Request-time fields the worker cannot recover later.
   * @returns `ok(void)` once the row is inserted; `err(BaseError)` if the
   *   insert throws.
   */
  override async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'requested' as const,
      channel: input.channel,
      actorUserId: input.actorUserId,
      actorOrgId: input.actorOrgId,
      actorAzp: input.actorAzp ?? null,
      piiFields: input.piiFields,
      itemCount: input.itemCount,
      requestedAt: input.requestedAt,
      requestedCount: input.itemCount,
      network: input.network ?? null,
      instance: input.instance ?? null,
      requestIp: input.requestIp ?? null,
      purpose: input.purpose ?? null,
      endpoint: input.endpoint,
      traceId: input.traceId ?? null,
      // `outcome` is deliberately absent: nothing has happened yet.
    });
  }

  /**
   * Inserts the `completed` row once a campaign job reaches a TERMINAL
   * status.
   *
   * @param input - Outcome + counts for the finished job, keyed by the same
   *   `correlationId` as the matching `recordRequested` call.
   * @returns `ok(void)` once the row is inserted; `err(BaseError)` if the
   *   insert throws.
   */
  override async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'completed' as const,
      channel: input.channel,
      actorOrgId: input.actorOrgId,
      outcome: input.outcome,
      completedAt: input.completedAt,
      destination: input.destination ?? null,
      resolvedCount: input.resolvedCount ?? null,
      skippedCount: input.skippedCount ?? null,
      failedCount: input.failedCount ?? null,
      sentCount: input.sentCount ?? null,
      errorCode: input.errorCode ?? null,
      recipientRef: input.recipientRef ?? null,
    });
  }

  /**
   * Inserts the single row for a synchronous, non-PII dump access.
   *
   * `actorOrgId` is intentionally omitted (a dump is whole-network) and
   * `piiFields` is set to an empty array rather than left null, asserting
   * positively that no PII field was released.
   *
   * @param input - Requester identity + outcome for the whole-network dump.
   * @returns `ok(void)` once the row is inserted; `err(BaseError)` if the
   *   insert throws.
   */
  override async recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'completed' as const,
      channel: 'dump' as const,
      actorUserId: input.actorUserId,
      // actorOrgId intentionally omitted — a dump is whole-network, no org.
      actorAzp: input.actorAzp ?? null,
      // Empty, not null: asserts positively that no PII field was released.
      piiFields: [],
      outcome: input.outcome,
      completedAt: input.completedAt,
      destination: input.destination ?? null,
      network: input.network ?? null,
      instance: input.instance ?? null,
      requestIp: input.requestIp ?? null,
      endpoint: input.endpoint,
      traceId: input.traceId ?? null,
      errorCode: input.errorCode ?? null,
      details: input.details ?? null,
    });
  }

  /**
   * Shared INSERT path for all three public methods. Never reads, updates,
   * or deletes — that absence is the append-only guarantee.
   *
   * @param row - Fully-shaped `campaign_pii_audit` row to insert.
   * @returns `ok(void)` on success; `err(UpstreamError)` wrapping the thrown
   *   cause if the insert fails.
   */
  private async insert(row: Record<string, unknown>): Promise<Result<void, BaseError>> {
    try {
      if (this.statementTimeoutMs !== undefined && this.db.transaction) {
        const timeoutMs = this.statementTimeoutMs;
        await this.db.transaction(async (tx) => {
          // `SET LOCAL` only takes effect for the current transaction and is
          // reset automatically at COMMIT/ROLLBACK — safe on a pooled
          // connection with no explicit reset needed. The value is our own
          // internal, non-user-controlled constant, so a literal (rather than
          // a bind parameter, which Postgres' SET command doesn't accept) is
          // safe here.
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
          await tx.insert(campaignPiiAudit).values(row);
        });
      } else {
        await this.db.insert(campaignPiiAudit).values(row);
      }
      return ok(undefined);
    } catch (cause) {
      return err(
        new UpstreamError('campaign audit insert failed', {
          cause,
          code: 'CAMPAIGN_AUDIT_INSERT_FAILED',
        }),
      );
    }
  }
}
