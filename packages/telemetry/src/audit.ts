/**
 * Audit event stub for the `@aggregator-dpg/telemetry` package.
 *
 * The full audit pipeline (signed records, S3 Object Lock, KMS key,
 * dedicated BullMQ queue per design §6.3) is out of scope for this
 * implementation. This stub forwards each record to pino at WARN so
 * audit events still land in the regular log stream during the gap.
 */

import type { Logger } from 'pino';

/**
 * A single audit event record.
 *
 * Captures the event name, the primary entity it concerns, and any
 * additional context attributes. When the full audit pipeline ships
 * (Phase 4+) this interface will be extended with signing metadata;
 * the shape is intentionally minimal for now.
 */
export interface AuditRecord {
  /** The audit event name, e.g. `'bulk_row.processed'`. */
  event: string;
  /** The ID of the primary entity this audit event concerns. */
  entity_id: string;
  /** Additional context attributes to include in the log record. */
  attributes: Record<string, unknown>;
}

/**
 * Emits an audit event by forwarding it to the supplied pino logger at WARN level.
 *
 * Until the real audit pipeline (signed records, S3 Object Lock, KMS key,
 * dedicated BullMQ queue) ships, this function ensures audit records appear
 * in the regular structured log stream so they are not silently dropped.
 *
 * @param record - The audit event to emit.
 * @param logger - A pino Logger instance to write to.
 */
export function emitAudit(record: AuditRecord, logger: Logger): void {
  logger.warn(
    {
      operation: 'telemetry.audit.emit',
      event_kind: 'audit',
      event: record.event,
      entity_id: record.entity_id,
      ...record.attributes,
    },
    'audit',
  );
}
