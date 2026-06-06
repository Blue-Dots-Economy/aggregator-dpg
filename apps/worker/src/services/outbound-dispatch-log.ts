/**
 * Worker-side adapter for the `outbound_dispatch_log` table.
 *
 * Mirrors `apps/api/src/services/outbound-dispatch-log/postgres.ts` —
 * we cannot import that adapter from `apps/api` (cross-app coupling),
 * so this worker-local file talks to Drizzle directly. The wire shape
 * is intentionally narrowed to the {@link DispatcherLog} interface the
 * processor uses (`findById`, `markSent`, `markFailed`,
 * `markSkippedLifecycle`); enqueue lives in `apps/api` because the
 * registration handler is the only producer.
 *
 * Each method swallows DB exceptions and surfaces them via a tiny
 * `{ success, value | error }` envelope so the processor never deals
 * with raw throws.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db.js';
import { logger } from '../logger.js';
import type { DispatcherLog, OutboundDispatchRow } from '../jobs/outbound-dispatch.js';

const log = schema.outboundDispatchLog;

/**
 * Drizzle-backed implementation of the {@link DispatcherLog} contract.
 *
 * Lazy singleton — instantiated on first {@link getOutboundDispatchLog}
 * call. Tests override via {@link _setOutboundDispatchLog}.
 */
class PostgresDispatcherLog implements DispatcherLog {
  async findById(
    id: string,
  ): Promise<
    { success: true; value: OutboundDispatchRow | null } | { success: false; error: Error }
  > {
    try {
      const [row] = await getDb().select().from(log).where(eq(log.id, id)).limit(1);
      if (!row) return { success: true, value: null };
      return {
        success: true,
        value: {
          id: row.id,
          itemId: row.itemId,
          channel: row.channel as OutboundDispatchRow['channel'],
          templateId: row.templateId,
          payload: row.payload,
        },
      };
    } catch (e) {
      const cause = e as Error;
      logger.error({
        operation: 'outboundDispatchLog.findById',
        status: 'failure',
        error: cause.message,
        error_type: cause.constructor?.name,
        dispatch_id: id,
      });
      return { success: false, error: cause };
    }
  }

  async markSent(id: string): Promise<unknown> {
    try {
      await getDb()
        .update(log)
        .set({ status: 'sent', sentAt: new Date() })
        .where(and(eq(log.id, id), eq(log.status, 'queued')));
    } catch (e) {
      const cause = e as Error;
      logger.error({
        operation: 'outboundDispatchLog.markSent',
        status: 'failure',
        error: cause.message,
        dispatch_id: id,
      });
    }
    return;
  }

  async markFailed(id: string, error: string): Promise<unknown> {
    try {
      await getDb()
        .update(log)
        .set({ status: 'failed', error, attempt: sql`${log.attempt} + 1` })
        .where(eq(log.id, id));
    } catch (e) {
      const cause = e as Error;
      logger.error({
        operation: 'outboundDispatchLog.markFailed',
        status: 'failure',
        error: cause.message,
        dispatch_id: id,
      });
    }
    return;
  }

  async markSkippedLifecycle(id: string): Promise<unknown> {
    try {
      await getDb()
        .update(log)
        .set({ status: 'skipped_lifecycle' })
        .where(and(eq(log.id, id), eq(log.status, 'queued')));
    } catch (e) {
      const cause = e as Error;
      logger.error({
        operation: 'outboundDispatchLog.markSkippedLifecycle',
        status: 'failure',
        error: cause.message,
        dispatch_id: id,
      });
    }
    return;
  }
}

let _dispatcherLog: DispatcherLog | null = null;

/**
 * Returns the worker's dispatcher-log singleton. Tests may override via
 * {@link _setOutboundDispatchLog} (pass null to reset to the default).
 */
export function getOutboundDispatchLog(): DispatcherLog {
  if (_dispatcherLog) return _dispatcherLog;
  _dispatcherLog = new PostgresDispatcherLog();
  return _dispatcherLog;
}

/** Test hook — inject a fake or reset. */
export function _setOutboundDispatchLog(impl: DispatcherLog | null): void {
  _dispatcherLog = impl;
}
