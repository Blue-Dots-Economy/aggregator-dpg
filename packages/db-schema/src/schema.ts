/**
 * Postgres schema definitions for the Aggregator API.
 *
 * Tables:
 *   - `aggregators`: registration-essential identity. Captured during signup
 *     so that the user can authenticate immediately after submitting. Holds
 *     id, slug, actor_type, name/type, url, Beckn `contact` (+ generated
 *     `contact_phone` / `contact_email` for indexed login lookups), Beckn
 *     `locations`, `consent` (T&C snapshot — accepted before account create),
 *     lifecycle `status`, and audit fields. `org_slug` is derived from `name`
 *     at INSERT and is immutable (trigger lives in the migration).
 *   - `aggregator_profile`: secondary, 1:1 with `aggregators`. Filled out
 *     post-login via the profile-completion flow. Holds `contact_name`,
 *     `personas`, `services`, `verified_certificate`, and a
 *     `profile_completed_at` checkpoint. A stub row is inserted alongside the
 *     parent in the same transaction so the 1:1 invariant always holds.
 *   - `bulk_uploads`: parent record per CSV upload. Tracks lifecycle
 *     (pending → uploaded → file_validating → row_processing → completed/failed)
 *     plus counters (passed/failed/skipped). Per-row state lives transiently
 *     in Redis during the run and `errors.csv` on S3 after.
 *
 * Keycloak remains the authoritative store for `phoneNumber`, `email`, and
 * `decision_made` (approval state); those values are mirrored into the
 * `aggregators.contact` jsonb for query / Beckn-shape passthrough.
 *
 * CHECK constraints (shape guards on jsonb, conditional integrity on
 * actor_type ↔ type) and the immutability trigger on `org_slug` are declared
 * in the migration, not here.
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
import type {
  BecknContact,
  BecknLocation,
  ConsentRecord,
  PersonaRef,
  PublicKeyEntry,
  ServiceRef,
} from '@aggregator-dpg/shared-primitives/aggregator';

export type { BecknContact, BecknLocation, ConsentRecord, PersonaRef, PublicKeyEntry, ServiceRef };

// ─── Enums ───────────────────────────────────────────────────────────────────

export const aggregatorActorTypeEnum = pgEnum('aggregator_actor_type', [
  'aggregator',
  'seeker',
  'provider',
]);

export const aggregatorTypeEnum = pgEnum('aggregator_type', ['seeker', 'provider', 'both']);

export const aggregatorStatusEnum = pgEnum('aggregator_status', [
  'pending',
  'active',
  'inactive',
  'retired',
]);

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

export const aggregators = pgTable(
  'aggregators',
  {
    // Identity
    id: uuid('id').primaryKey().defaultRandom(),
    orgSlug: text('org_slug').notNull().unique(),
    actorType: aggregatorActorTypeEnum('actor_type').notNull(),
    name: text('name').notNull(),
    // `type` is NULL when actor_type='aggregator' (enforced by CHECK).
    type: aggregatorTypeEnum('type'),
    url: text('url'),

    // Beckn Contact (mirrored from Keycloak — KC is authoritative for
    // phone/email; this jsonb is the Beckn-shape projection for catalog reads).
    contact: jsonb('contact').$type<BecknContact>().notNull(),
    contactPhone: text('contact_phone')
      .notNull()
      .generatedAlwaysAs(sql`(contact->>'phone')`),
    contactEmail: text('contact_email')
      .notNull()
      .generatedAlwaysAs(sql`(lower(contact->>'email'))`),

    // Beckn Location[] — optional list of geographic locations.
    locations: jsonb('locations')
      .$type<BecknLocation[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Onboarding consent (snapshot at signup; aggregator must accept T&C
    // before the row is created). Refreshable via PATCH.
    consent: jsonb('consent').$type<ConsentRecord>().notNull(),

    // Lifecycle
    status: aggregatorStatusEnum('status').notNull().default('pending'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Signalstack organisation id returned by POST /admin/aggregator/upsert.
    // Mirrors the `signalstack_org_id` Keycloak user attribute so the worker
    // process (no KC admin client) and the anonymous public-link submission
    // path can resolve the per-call `x-acting-org-id` header without an
    // extra KC round-trip. NULL until the admin-approval flow (or the
    // login-time backfill) records it.
    signalstackOrgId: text('signalstack_org_id'),
  },
  (table) => ({
    // Auth-path lookups: phone/email are the credential identifiers a user
    // types in at login. Uniqueness prevents duplicate registration.
    contactPhoneUnique: uniqueIndex('aggregators_contact_phone_unique').on(table.contactPhone),
    contactEmailUnique: uniqueIndex('aggregators_contact_email_unique').on(table.contactEmail),
    // Approval queue + tenant-classification filters.
    statusIdx: index('aggregators_status_idx').on(table.status),
    actorTypeIdx: index('aggregators_actor_type_idx').on(table.actorType),
  }),
);

// ─── aggregator_profile ──────────────────────────────────────────────────────

export const aggregatorProfile = pgTable(
  'aggregator_profile',
  {
    aggregatorId: uuid('aggregator_id')
      .primaryKey()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    // Display label for the primary human contact at the aggregator org.
    // Distinct from `aggregators.contact.name` (which is the Beckn contact
    // object's `name` field on the structured contact payload).
    contactName: text('contact_name'),
    // Schema-registry references — IDs validated at app layer against the
    // active schema registry (config/schema-registry.yaml).
    personas: jsonb('personas')
      .$type<PersonaRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    services: jsonb('services')
      .$type<ServiceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    verifiedCertificate: jsonb('verified_certificate')
      .$type<PublicKeyEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // NULL until profile_completed_at is stamped (when all required profile
    // fields are present). Powers the "complete your profile" UI banner and
    // Beckn-catalog visibility filter.
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Beckn catalog discovery: "all aggregators supporting persona X / service Y".
    personasGin: index('aggregator_profile_personas_gin').using('gin', table.personas),
    servicesGin: index('aggregator_profile_services_gin').using('gin', table.services),
    profileCompletedIdx: index('aggregator_profile_completed_at_idx').on(table.profileCompletedAt),
  }),
);

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
    // ETag captured by HEAD when the browser confirms upload (POST /:id/start).
    // NULL while status='pending'.
    s3Etag: text('s3_etag'),
    status: bulkUploadStatusEnum('status').notNull().default('pending'),
    statusReason: text('status_reason'),
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
    // Per-aggregator slug uniqueness — two aggregators may pick the same
    // human-readable slug since the public URL is `/<org_slug>/<slug>`.
    aggregatorSlugUnique: uniqueIndex('registration_links_aggregator_slug_unique').on(
      table.aggregatorId,
      table.slug,
    ),
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
    // Dedup key includes `type` so a seeker and a provider can share the same
    // external participant_id under one aggregator without colliding.
    aggregatorTypeParticipantUnique: uniqueIndex(
      'participants_aggregator_type_participant_unique',
    ).on(table.aggregatorId, table.type, table.participantId),
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
export type AggregatorProfileRow = typeof aggregatorProfile.$inferSelect;
export type NewAggregatorProfileRow = typeof aggregatorProfile.$inferInsert;
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
