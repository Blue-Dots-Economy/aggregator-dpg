/**
 * Postgres adapter for the outbound dispatch log.
 *
 * Wraps Drizzle queries against the `outbound_dispatch_log` table. The
 * `enqueue` path uses `INSERT … ON CONFLICT … DO UPDATE SET id = id`
 * to coerce RETURNING to fire for both the inserted row and the
 * pre-existing conflicting row, making the call idempotent on the
 * composite unique index `(participant_id, item_id, channel, template_id)`.
 *
 * Driver-level errors are normalised to `UpstreamError`; business-rule
 * failures (missing row, illegal status transition) surface as
 * `DomainError`. Methods never throw across the service boundary.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboundDispatchLog } from '@aggregator-dpg/db-schema/schema';
import { DomainError, UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import { logger } from '../../logger.js';
import {
  OutboundDispatchLogBase,
  type Channel,
  type EnqueueInput,
  type OutboundDispatchRow,
  type Status,
} from './interface.js';

// Drizzle is generic over its schema map; accept the loosest viable type
// so both the shared `db` handle and ad-hoc transaction handles work.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbHandle = NodePgDatabase<any>;

/** Real Postgres implementation. */
export class PostgresOutboundDispatchLog extends OutboundDispatchLogBase {
  constructor(private readonly db: DbHandle) {
    super();
  }

  override async enqueue(input: EnqueueInput): Promise<Result<OutboundDispatchRow, BaseError>> {
    const start = Date.now();
    try {
      const rows = await this.db
        .insert(outboundDispatchLog)
        .values({
          aggregatorId: input.aggregator_id,
          participantId: input.participant_id,
          itemId: input.item_id,
          channel: input.channel,
          templateId: input.template_id,
          payload: input.payload ?? {},
        })
        .onConflictDoUpdate({
          target: [
            outboundDispatchLog.participantId,
            outboundDispatchLog.itemId,
            outboundDispatchLog.channel,
            outboundDispatchLog.templateId,
          ],
          // No-op SET — forces RETURNING to fire for the existing row.
          set: { id: sql`${outboundDispatchLog.id}` },
        })
        .returning();
      const row = rows[0];
      if (!row) {
        return err(
          new UpstreamError('outbound_dispatch_log enqueue returned no row', {
            code: 'NO_ROW_RETURNED',
          }),
        );
      }
      logger.info({
        operation: 'outboundDispatchLog.enqueue',
        status: 'success',
        latency_ms: Date.now() - start,
        dispatch_id: row.id,
      });
      return ok(toDomain(row));
    } catch (e) {
      return this.mapWriteError('outboundDispatchLog.enqueue', e, start);
    }
  }

  override async markSent(id: string): Promise<Result<OutboundDispatchRow, BaseError>> {
    const start = Date.now();
    try {
      const rows = await this.db
        .update(outboundDispatchLog)
        .set({ status: 'sent', sentAt: new Date() })
        .where(and(eq(outboundDispatchLog.id, id), eq(outboundDispatchLog.status, 'queued')))
        .returning();
      const row = rows[0];
      if (!row) {
        return err(
          new DomainError(`dispatch row not found or not queued: ${id}`, {
            code: 'INVALID_TRANSITION',
          }),
        );
      }
      logger.info({
        operation: 'outboundDispatchLog.markSent',
        status: 'success',
        latency_ms: Date.now() - start,
        dispatch_id: id,
      });
      return ok(toDomain(row));
    } catch (e) {
      return this.mapWriteError('outboundDispatchLog.markSent', e, start);
    }
  }

  override async markFailed(
    id: string,
    error: string,
  ): Promise<Result<OutboundDispatchRow, BaseError>> {
    const start = Date.now();
    try {
      const rows = await this.db
        .update(outboundDispatchLog)
        .set({
          status: 'failed',
          error,
          attempt: sql`${outboundDispatchLog.attempt} + 1`,
        })
        .where(eq(outboundDispatchLog.id, id))
        .returning();
      const row = rows[0];
      if (!row) {
        return err(new DomainError(`dispatch row not found: ${id}`, { code: 'NOT_FOUND' }));
      }
      logger.warn({
        operation: 'outboundDispatchLog.markFailed',
        status: 'success',
        latency_ms: Date.now() - start,
        dispatch_id: id,
        attempt: row.attempt,
      });
      return ok(toDomain(row));
    } catch (e) {
      return this.mapWriteError('outboundDispatchLog.markFailed', e, start);
    }
  }

  override async markSkippedLifecycle(id: string): Promise<Result<OutboundDispatchRow, BaseError>> {
    const start = Date.now();
    try {
      const rows = await this.db
        .update(outboundDispatchLog)
        .set({ status: 'skipped_lifecycle' })
        .where(and(eq(outboundDispatchLog.id, id), eq(outboundDispatchLog.status, 'queued')))
        .returning();
      const row = rows[0];
      if (!row) {
        return err(
          new DomainError(`dispatch row not found or not queued: ${id}`, {
            code: 'INVALID_TRANSITION',
          }),
        );
      }
      logger.info({
        operation: 'outboundDispatchLog.markSkippedLifecycle',
        status: 'success',
        latency_ms: Date.now() - start,
        dispatch_id: id,
      });
      return ok(toDomain(row));
    } catch (e) {
      return this.mapWriteError('outboundDispatchLog.markSkippedLifecycle', e, start);
    }
  }

  override async findById(id: string): Promise<Result<OutboundDispatchRow | null, BaseError>> {
    const start = Date.now();
    try {
      const [row] = await this.db
        .select()
        .from(outboundDispatchLog)
        .where(eq(outboundDispatchLog.id, id))
        .limit(1);
      return ok(row ? toDomain(row) : null);
    } catch (e) {
      return this.mapReadError('outboundDispatchLog.findById', e, start);
    }
  }

  override async listByParticipant(
    participantId: string,
  ): Promise<Result<OutboundDispatchRow[], BaseError>> {
    const start = Date.now();
    try {
      const rows = await this.db
        .select()
        .from(outboundDispatchLog)
        .where(eq(outboundDispatchLog.participantId, participantId))
        .orderBy(asc(outboundDispatchLog.createdAt));
      return ok(rows.map(toDomain));
    } catch (e) {
      return this.mapReadError('outboundDispatchLog.listByParticipant', e, start);
    }
  }

  // ─── Error mapping ─────────────────────────────────────────────────────────

  private mapWriteError(op: string, e: unknown, start: number): Result<never, BaseError> {
    const cause = e as Error;
    logger.error({
      operation: op,
      status: 'failure',
      error: cause.message,
      error_type: cause.constructor?.name,
      latency_ms: Date.now() - start,
    });
    return err(
      new UpstreamError(`${op} failed: ${cause.message}`, {
        cause,
        code: 'DB_WRITE_FAILED',
      }),
    );
  }

  private mapReadError(op: string, e: unknown, start: number): Result<never, BaseError> {
    const cause = e as Error;
    logger.error({
      operation: op,
      status: 'failure',
      error: cause.message,
      error_type: cause.constructor?.name,
      latency_ms: Date.now() - start,
    });
    return err(
      new UpstreamError(`${op} failed: ${cause.message}`, {
        cause,
        code: 'DB_READ_FAILED',
      }),
    );
  }
}

/** Maps a Drizzle row into the domain shape. */
function toDomain(row: typeof outboundDispatchLog.$inferSelect): OutboundDispatchRow {
  return {
    id: row.id,
    aggregatorId: row.aggregatorId,
    participantId: row.participantId,
    itemId: row.itemId,
    channel: row.channel as Channel,
    templateId: row.templateId,
    status: row.status as Status,
    attempt: row.attempt,
    error: row.error ?? null,
    payload: row.payload,
    queuedAt: row.queuedAt,
    sentAt: row.sentAt ?? null,
    createdAt: row.createdAt,
  };
}
