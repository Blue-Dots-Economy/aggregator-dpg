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

import { sql } from 'drizzle-orm';
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

export const registrationLinkStatusEnum = pgEnum('registration_link_status', [
  'draft',
  'live',
  'retired',
]);

export const linkSubmissionOutcomeEnum = pgEnum('link_submission_outcome', [
  'passed',
  'skipped',
  'failed',
]);

export const onboardingSourceEnum = pgEnum('onboarding_source', ['bulk', 'link']);

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

// ─── registration_links ──────────────────────────────────────────────────────

export const registrationLinks = pgTable(
  'registration_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    domain: participantTypeEnum('domain').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    qrObjectKey: text('qr_object_key'),
    status: registrationLinkStatusEnum('status').notNull().default('draft'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('registration_links_slug_unique').on(table.slug),
    aggregatorStatusIdx: index('registration_links_aggregator_status_idx').on(
      table.aggregatorId,
      table.status,
    ),
  }),
);

// ─── participants ────────────────────────────────────────────────────────────

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    type: participantTypeEnum('type').notNull(),
    // Schema-supplied unique identifier from the data source (e.g. ITI roll
    // number, employee id). Not the same as `id` (DB row id). Dedup is
    // (aggregator_id, participant_id) — the same external id can exist
    // under different aggregators.
    participantId: text('participant_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    phone: text('phone'),
    email: text('email'),
    sourceBulkUploadId: uuid('source_bulk_upload_id').references(() => bulkUploads.id, {
      onDelete: 'set null',
    }),
    sourceLinkId: uuid('source_link_id').references(() => registrationLinks.id, {
      onDelete: 'set null',
    }),
    sourceRowIndex: integer('source_row_index'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aggregatorParticipantUnique: uniqueIndex('participants_aggregator_participant_unique').on(
      table.aggregatorId,
      table.participantId,
    ),
    aggregatorPhoneIdx: index('participants_aggregator_phone_idx').on(
      table.aggregatorId,
      table.phone,
    ),
    sourceBulkIdx: index('participants_source_bulk_idx').on(table.sourceBulkUploadId),
    sourceLinkIdx: index('participants_source_link_idx').on(table.sourceLinkId),
  }),
);

// ─── link_submissions ────────────────────────────────────────────────────────

export const linkSubmissions = pgTable(
  'link_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => registrationLinks.id, { onDelete: 'cascade' }),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    participantId: uuid('participant_id').references(() => participants.id, {
      onDelete: 'set null',
    }),
    metadataSnapshot: jsonb('metadata_snapshot')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    submittedData: jsonb('submitted_data').$type<Record<string, unknown>>().notNull().default({}),
    outcome: linkSubmissionOutcomeEnum('outcome').notNull(),
    rolledUpAt: timestamp('rolled_up_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Metrics Aggregator pickup: NULLS FIRST surfaces unrolled rows first.
    rollupPickupIdx: index('link_submissions_rollup_pickup_idx').on(
      table.rolledUpAt,
      table.createdAt,
    ),
    linkIdx: index('link_submissions_link_idx').on(table.linkId),
    aggregatorCreatedIdx: index('link_submissions_aggregator_created_idx').on(
      table.aggregatorId,
      table.createdAt,
    ),
  }),
);

// ─── onboarding (unified metrics rollup) ─────────────────────────────────────

export const onboarding = pgTable(
  'onboarding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    orgSlug: text('org_slug').notNull(),
    source: onboardingSourceEnum('source').notNull(),
    // For source='bulk': bulk_uploads.id. For source='link': NULL.
    batchId: uuid('batch_id'),
    // For source='link': registration_links.id. For source='bulk': NULL.
    linkId: uuid('link_id').references(() => registrationLinks.id, { onDelete: 'set null' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    total: integer('total').notNull(),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Bulk: one row per upload (batch_id is the upload id).
    // Partial UNIQUE so the constraint applies only when source='bulk'.
    bulkBatchUnique: uniqueIndex('onboarding_bulk_batch_unique')
      .on(table.batchId)
      .where(sql`${table.source} = 'bulk'`),
    // Link: one row per (aggregator, link, period). UPSERT target for
    // Metrics Aggregator hour-bucket rollups.
    linkRollupUnique: uniqueIndex('onboarding_link_rollup_unique')
      .on(table.aggregatorId, table.linkId, table.periodStart)
      .where(sql`${table.source} = 'link'`),
    aggregatorSourceIdx: index('onboarding_aggregator_source_idx').on(
      table.aggregatorId,
      table.source,
      table.periodStart,
    ),
    batchIdx: index('onboarding_batch_idx').on(table.batchId),
  }),
);

// ─── Inferred row types ──────────────────────────────────────────────────────

export type AggregatorRow = typeof aggregators.$inferSelect;
export type NewAggregatorRow = typeof aggregators.$inferInsert;
export type AggregatorProfileRow = typeof aggregatorProfiles.$inferSelect;
export type NewAggregatorProfileRow = typeof aggregatorProfiles.$inferInsert;
export type BulkUploadRow = typeof bulkUploads.$inferSelect;
export type NewBulkUploadRow = typeof bulkUploads.$inferInsert;
export type ParticipantRow = typeof participants.$inferSelect;
export type NewParticipantRow = typeof participants.$inferInsert;
export type RegistrationLinkRow = typeof registrationLinks.$inferSelect;
export type NewRegistrationLinkRow = typeof registrationLinks.$inferInsert;
export type LinkSubmissionRow = typeof linkSubmissions.$inferSelect;
export type NewLinkSubmissionRow = typeof linkSubmissions.$inferInsert;
export type OnboardingRow = typeof onboarding.$inferSelect;
export type NewOnboardingRow = typeof onboarding.$inferInsert;
