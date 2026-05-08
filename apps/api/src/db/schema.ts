/**
 * Postgres schema definitions for the Aggregator API.
 *
 * Tables:
 *   - `aggregators`: org-level data only (id, slug, type, timestamps).
 *   - `aggregator_profiles`: per-aggregator profile JSON, populated post-login.
 *   - `bulk_uploads`: parent record per CSV upload. Tracks lifecycle
 *     (pending → uploaded → file_validating → row_processing → completed/failed)
 *     plus counters (passed/failed/skipped). Per-row state lives transiently
 *     in Redis during the run and `errors.csv` on S3 after.
 *
 * No PII is stored in `aggregators` or `aggregator_profiles`. Email, phone,
 * and contact name live in Keycloak.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const aggregatorTypeEnum = pgEnum('aggregator_type', ['seeker', 'provider']);

export const participantTypeEnum = pgEnum('participant_type', ['seeker', 'provider']);

export const bulkUploadStatusEnum = pgEnum('bulk_upload_status', [
  'pending',
  'uploaded',
  'file_validating',
  'file_failed',
  'row_processing',
  'finalising',
  'completed',
  'failed',
]);

// ─── aggregators ─────────────────────────────────────────────────────────────

export const aggregators = pgTable('aggregators', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgSlug: text('org_slug').notNull().unique(),
  type: aggregatorTypeEnum('type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── aggregator_profiles ─────────────────────────────────────────────────────

export const aggregatorProfiles = pgTable('aggregator_profiles', {
  aggregatorId: uuid('aggregator_id')
    .primaryKey()
    .references(() => aggregators.id, { onDelete: 'cascade' }),
  schemaVersion: integer('schema_version').notNull().default(1),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  consent: jsonb('consent').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── bulk_uploads ────────────────────────────────────────────────────────────

export const bulkUploads = pgTable(
  'bulk_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    participantType: participantTypeEnum('participant_type').notNull(),
    s3Key: text('s3_key').notNull(),
    s3Etag: text('s3_etag').notNull(),
    status: bulkUploadStatusEnum('status').notNull().default('pending'),
    statusReason: text('status_reason'),
    totalRows: integer('total_rows'),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    errorsCsvS3Key: text('errors_csv_s3_key'),
    schemaId: text('schema_id').notNull(),
    schemaVersion: text('schema_version').notNull(),
    uploadedBy: uuid('uploaded_by').notNull(),
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    // Re-upload of identical CSV under the same aggregator is idempotent.
    aggregatorEtagUnique: uniqueIndex('bulk_uploads_aggregator_etag_unique').on(
      table.aggregatorId,
      table.s3Etag,
    ),
    // Watchdog scan: status + last_progress_at to detect stalled jobs.
    statusProgressIdx: index('bulk_uploads_status_progress_idx').on(
      table.status,
      table.lastProgressAt,
    ),
    // Per-aggregator concurrent cap + tenant isolation queries.
    aggregatorStatusIdx: index('bulk_uploads_aggregator_status_idx').on(
      table.aggregatorId,
      table.status,
    ),
  }),
);

// ─── Inferred row types ──────────────────────────────────────────────────────

export type AggregatorRow = typeof aggregators.$inferSelect;
export type NewAggregatorRow = typeof aggregators.$inferInsert;
export type AggregatorProfileRow = typeof aggregatorProfiles.$inferSelect;
export type NewAggregatorProfileRow = typeof aggregatorProfiles.$inferInsert;
export type BulkUploadRow = typeof bulkUploads.$inferSelect;
export type NewBulkUploadRow = typeof bulkUploads.$inferInsert;
