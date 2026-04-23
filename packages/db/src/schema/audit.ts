/**
 * Drizzle schema for audit_log table.
 *
 * Immutable append-only log of significant user actions.
 * occurred_at = the real event timestamp (set by caller, may differ from DB
 * write time when events are ingested asynchronously).
 * created_at  = DB insert timestamp (always now()).
 *
 * @module @aggregator-dpg/db/schema
 */

import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { aggregatorProfile } from './aggregator.js';

/**
 * Immutable audit trail for all significant platform actions.
 *
 * FK aggregator_id → aggregator_profile.aggregator_id ON DELETE RESTRICT.
 * Audit records must be preserved — aggregators cannot be hard-deleted while
 * audit rows exist.
 *
 * No UPDATE or DELETE should ever be issued against this table.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** FK → aggregator_profile.aggregator_id; RESTRICT on delete. */
  aggregatorId: uuid('aggregator_id')
    .notNull()
    .references(() => aggregatorProfile.aggregatorId, { onDelete: 'restrict' }),
  /** ID of the user who performed the action (null for system-initiated events). */
  userId: text('user_id'),
  /** Verb describing the action (e.g. 'create', 'update', 'revoke', 'export'). */
  action: text('action').notNull(),
  /** Entity type the action was performed on (e.g. 'onboarding_link', 'export_job'). */
  entity: text('entity').notNull(),
  /** Primary key of the affected entity row. */
  entityId: text('entity_id').notNull(),
  /** Snapshot of relevant request/response payload at the time of the action. */
  payloadJson: jsonb('payload_json'),
  /** Real event timestamp — when the action occurred, set by the caller. */
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  /** DB insert timestamp — when this row was written. */
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
