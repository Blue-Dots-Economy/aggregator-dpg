/**
 * Drizzle-backed audit writer.
 *
 * Only ever INSERTs. There is no update or delete here, and none should be
 * added — see the interface module doc.
 *
 * @module @aggregator-dpg/campaign-audit/postgres
 */
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

/** Minimal shape this writer needs — avoids coupling to a concrete Drizzle client type. */
export interface AuditDb {
  insert: (table: typeof campaignPiiAudit) => { values: (row: unknown) => Promise<unknown> };
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
   */
  constructor(private readonly db: AuditDb) {
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
      await this.db.insert(campaignPiiAudit).values(row);
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
