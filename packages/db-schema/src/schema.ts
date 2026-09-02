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

// `participant_type` + `aggregator_type` Postgres enums were dropped in
// migration 0011 — the aggregator is generic across signalstack networks
// (blue_dot has seeker/provider, yellow_dot has learner/tutor, …) so the
// closed enum no longer fits. Columns that used these enums are now plain
// `text`; validation against the live network's `domainIds` happens at
// the application layer.

export const aggregatorStatusEnum = pgEnum('aggregator_status', [
  'pending',
  'active',
  'inactive',
  'retired',
]);

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

/**
 * Lifecycle of a targeted coordinator invite (#700). `pending` is the only
 * live state; `consumed` (registered), `revoked` (owner/org cancelled), and
 * `expired` are terminal. The partial-unique index on
 * `registration_invites` keys off `status = 'pending'` so exactly one live
 * invite exists per (org, email).
 */
export const registrationInviteStatusEnum = pgEnum('registration_invite_status', [
  'pending',
  'consumed',
  'revoked',
  'expired',
]);

// ─── Campaign async-job engine (#579) ────────────────────────────────────────
// Durable job model shared by every campaign channel (export/email/voice). A
// request becomes one `campaign_job` row plus one `campaign_job_item` row per
// target item; the worker writes per-item terminal statuses and the job status
// is always DERIVED from item counts (never a stored counter — see
// `campaign-job-store`), so it can't drift.

/**
 * Roll-up status of a whole campaign job, derived from its item statuses.
 * Names follow the async batch-processing design: a job is `queued` until the
 * worker picks it up, then `processing`, then one of the three terminals —
 * `completed` (no failures), `partial` (a mix), `failed` (nothing succeeded).
 */
export const campaignJobStatusEnum = pgEnum('campaign_job_status', [
  'queued',
  'processing',
  'partial',
  'completed',
  'failed',
]);

/**
 * Status of a single job item — the durable row-model shared by every channel.
 *
 * Non-terminal: `pending`.
 * Success terminals: `resolved` (data fetched/produced — export), `submitted`
 * (side-effect dispatched, outcome pending reconciliation — voice), `sent`
 * (delivery confirmed — email).
 * Skip terminals (not failures — they do not make a job `partial`):
 * `skipped_not_owned` (the org does not own the item), `skipped_no_contact`
 * (no address/number to reach), `duplicate_active` (the same (item, action) is
 * already in flight elsewhere).
 * Error terminal: `failed`.
 */
export const campaignJobItemStatusEnum = pgEnum('campaign_job_item_status', [
  'pending',
  'resolved',
  'submitted',
  'sent',
  'skipped_not_owned',
  'skipped_no_contact',
  'duplicate_active',
  'failed',
]);

/** Which campaign channel a job belongs to; picks the worker handler. */
export const campaignChannelEnum = pgEnum('campaign_channel', ['export', 'email', 'voice']);

/**
 * Which phase of a campaign's life this audit row records. NOT the outcome —
 * see `campaignAuditOutcomeEnum`. A campaign produces two rows (`requested`,
 * then `completed`) sharing a correlation id; a dump produces one `completed`.
 */
export const campaignAuditEventEnum = pgEnum('campaign_audit_event', ['requested', 'completed']);

/**
 * The audited action. Wider than `campaignChannelEnum` because the non-PII dump
 * is audited too — it releases the whole-network snapshot, and is the only
 * action with no org scoping at all.
 */
export const campaignAuditChannelEnum = pgEnum('campaign_audit_channel', [
  'export',
  'email',
  'voice',
  'dump',
]);

/** Result of a completed action. NULL on `requested` rows — nothing has happened yet. */
export const campaignAuditOutcomeEnum = pgEnum('campaign_audit_outcome', [
  'succeeded',
  'partial',
  'failed',
]);

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
    // Stored as text since 0011 — the network config decides which
    // domain ids are valid for the active deployment.
    type: text('type'),
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

    // Schema-driven registration payload (0018). Holds ONLY fields that have
    // no column of their own — the typed columns above stay authoritative for
    // everything they already carry, so there is never a second home for the
    // same value. A new field on the registration schema lands here, which is
    // what keeps a schema revision from needing a migration.
    profile: jsonb('profile')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Which schema variant produced `profile`, e.g. `blue_dot/up-gzb/registration.v1`.
    // The schemas vary per use case, so a row that does not name its own
    // contract cannot be interpreted later. NULL on rows created before 0018.
    profileRef: text('profile_ref'),

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

    // Parent org for the org→coordinator hierarchy (spec §5.2). The SINGLE
    // authority for the link (no KC group membership for coordinators in v1).
    // NULL = flat coordinator (flag off) or legacy orphan. Only populated when
    // ORG_HIERARCHY_ENABLED=true. FK → aggregator_orgs.id.
    parentOrgId: uuid('parent_org_id').references(
      (): typeof aggregatorOrgs.id => aggregatorOrgs.id,
    ),

    // The email a coordinator was INVITED at (#701), when they registered via an
    // invite. May differ from `contact_email` (they can register with their own
    // address) — kept for provenance so the approving owner can see who was
    // originally targeted. NULL for non-invite / flat registrations.
    inviteEmail: text('invite_email'),

    // Write-once timestamp of rejection (#726). Set exactly once when a
    // pending registration is rejected (status → inactive); never mutated
    // after. Powers the re-registration cooling window without depending on the
    // mutable `updated_at`. NULL until/unless rejected.
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
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

// ─── aggregator_orgs ─────────────────────────────────────────────────────────
// Thin system-of-record for a parent org (spec §5.1). The KC group is a
// future-authz mirror; status lives here so the approval single-use guard is
// an atomic compare-and-set (spec A3). Reuses `aggregator_status` enum
// (pending | active | inactive == rejected | retired).

export const aggregatorOrgs = pgTable(
  'aggregator_orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    state: text('state'),
    ownerEmail: text('owner_email').notNull(),
    ownerPhone: text('owner_phone'),
    ownerKcSub: text('owner_kc_sub'),
    kcGroupId: text('kc_group_id'),
    // Schema-driven registration payload (0018) — see the note on
    // `aggregators.profile`. `state` above stays authoritative for the state
    // name; the rest of the address and every field added by the Aug 2026
    // schema review live here.
    profile: jsonb('profile')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Which schema variant produced `profile`, e.g. `blue_dot/org-registration.v1`. */
    profileRef: text('profile_ref'),
    status: aggregatorStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Write-once rejection timestamp (#726) — see the aggregators note above.
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  },
  (table) => ({
    // Active-org dropdown + owner lookup are plain SQL (spec A2/A5).
    statusIdx: index('aggregator_orgs_status_idx').on(table.status),
    ownerEmailIdx: index('aggregator_orgs_owner_email_idx').on(table.ownerEmail),
    // Slug uniqueness only over non-terminal rows: a rejected/retired org
    // never blocks a later slug (spec A9). Partial unique index.
    slugActiveUnique: uniqueIndex('aggregator_orgs_slug_active_unique')
      .on(table.slug)
      .where(sql`status IN ('pending','active')`),
    // Org display name is unique (case-insensitive) over non-terminal rows —
    // same partial-unique semantics as the slug, so a rejected/retired org
    // never blocks reusing its name.
    displayNameActiveUnique: uniqueIndex('aggregator_orgs_display_name_active_unique')
      .on(sql`lower(${table.displayName})`)
      .where(sql`status IN ('pending','active')`),
  }),
);

// ─── registration_invites (#700) ─────────────────────────────────────────────
// Targeted coordinator invites. A row is required (unlike approval tokens,
// which get single-use for free by re-checking Keycloak `enabled`) because an
// invitee has no Keycloak user yet — the row is what buys single-use,
// revocation, and leak attribution. The invite JWT's `sub` is this row's `jti`.

export const registrationInvites = pgTable(
  'registration_invites',
  {
    jti: uuid('jti').primaryKey().defaultRandom(),
    /** Only `coordinator` in this phase; column keeps the door open for others. */
    role: text('role').notNull().default('coordinator'),
    parentOrgId: uuid('parent_org_id')
      .notNull()
      .references(() => aggregatorOrgs.id, { onDelete: 'cascade' }),
    /** Normalised (lowercased, trimmed) — enforced against the submitted email. */
    email: text('email').notNull(),
    status: registrationInviteStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The minting owner/admin subject — audit + leak attribution (§7). */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  // Array form (not the deprecated object-return extraConfig).
  (table) => [
    index('registration_invites_parent_org_idx').on(table.parentOrgId),
    // One live invite per (org, email): a re-invite refreshes rather than
    // duplicates. Partial unique over pending rows only, so a consumed/revoked/
    // expired invite never blocks re-inviting the same address.
    uniqueIndex('registration_invites_pending_unique')
      .on(table.parentOrgId, table.email)
      .where(sql`status = 'pending'`),
  ],
);

export type RegistrationInviteRow = typeof registrationInvites.$inferSelect;
export type NewRegistrationInviteRow = typeof registrationInvites.$inferInsert;

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
    // Stored as text since 0011 — accepts any domain id declared by the
    // active signalstack network. Application layer validates against
    // `getNetworkConfig().domainIds`.
    participantType: text('participant_type').notNull(),
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
    domain: text('domain').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    registrationMode: text('registration_mode').notNull().default('form'),
    // Legacy (#650): QR is now generated client-side; this is never written
    // going forward. Retained one release for legacy reads — do NOT reintroduce
    // a write. Drop in a follow-up migration.
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
    type: text('type').notNull(),
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

// ─── aggregator_consent_record ───────────────────────────────────────────────
// Append-only ledger of registration consent acceptances, keyed by a
// subject_type + subject_id so one table serves both org and coordinator
// registration flows. One row per acceptance; both document versions stored
// in-row (terms_version + privacy_version) so re-consent or version audits
// only need this table. No FK on subject_id — polymorphic at app level.

export const aggregatorConsentRecord = pgTable(
  'aggregator_consent_record',
  {
    /** Surrogate primary key; generated randomly by Postgres. */
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * Discriminator for the subject: `'org'` = `aggregator_orgs.id`;
     * `'aggregator'` = `aggregators.id` (coordinator/aggregator flow).
     */
    subjectType: text('subject_type').notNull(),

    /**
     * The id of the subject row that accepted the terms.
     * No cross-table FK (polymorphic); app-layer integrity is sufficient
     * because the route already owns the subject row at write time.
     */
    subjectId: uuid('subject_id').notNull(),

    /** Version of the Terms of Service document accepted (= config `current_version`). */
    termsVersion: integer('terms_version').notNull(),

    /** Version of the Privacy Policy document accepted (= config `current_version`). */
    privacyVersion: integer('privacy_version').notNull(),

    /** Signal Stack network identifier the registration is under (e.g. `blue_dot`). */
    network: text('network').notNull(),

    /** Per-brand variant, or NULL when the registration is under the network default. */
    brand: text('brand'),

    /**
     * How consent was captured — `'registration'` in v1 (future: `'re-consent'`).
     */
    source: text('source').notNull(),

    /** Server-stamped moment the registrant checked the consent checkbox. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),

    /** Row-creation timestamp; set automatically by Postgres on INSERT. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Ledger lookup: all consent records for a given subject (org or aggregator).
    subjectIdx: index('aggregator_consent_record_subject_idx').on(
      table.subjectType,
      table.subjectId,
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

// ─── campaign_job / campaign_job_item ────────────────────────────────────────

/**
 * A single free-form campaign metadata pair. The request envelope's `metadata`
 * list is stored verbatim on the job — there is no fixed allow-list; every pair
 * a caller sends is persisted as-is (e.g. `{key:'purpose', value:'audit'}`).
 */
export interface CampaignMetadataPair {
  key: string;
  value: string;
}

export const campaignJob = pgTable(
  'campaign_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    // Signalstack org id (the token's `signalstack_org_id` claim) — the tenant
    // scope every read/list/cap query filters on.
    signalstackOrgId: text('signalstack_org_id').notNull(),
    channel: campaignChannelEnum('channel').notNull(),
    status: campaignJobStatusEnum('status').notNull().default('queued'),
    // Request idempotency: a repeated `Idempotency-Key` returns the original
    // job instead of creating a second one. NULL when the caller omits it.
    idempotencyKey: text('idempotency_key'),
    // The request envelope's `metadata` list, stored verbatim.
    metadata: jsonb('metadata')
      .$type<CampaignMetadataPair[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Per-channel `content` block (empty `{}` for export).
    content: jsonb('content')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The requesting user (token email) — recipient/attribution, never trusted
    // from the client for authz.
    requestedBy: text('requested_by').notNull(),
    // Inbound `x-request-id`, forwarded downstream for tracing.
    requestId: text('request_id'),
    errorReason: text('error_reason'),
    // Heartbeat written each processing chunk; the watchdog fails jobs whose
    // `last_progress_at` goes stale.
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Stamped when the job reaches a terminal status.
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Stamped once the channel's user-visible notification has been sent (the
     * export's pre-signed download email). A job retry must not re-send it:
     * the recipient would get a second working link to the same PII.
     */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    // voice: raw create+start provider responses, captured for the campaign manager
    providerResponse: jsonb('provider_response'),
  },
  (table) => [
    // Request idempotency — PER TENANT. A global unique key would let one org's
    // key collide with another's: the insert would be swallowed by
    // onConflictDoNothing, the caller would get the other org's job id back,
    // and their export would silently never run.
    uniqueIndex('campaign_job_idempotency_key_unique')
      .on(table.signalstackOrgId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // Tenant list (newest-first) + per-org active-job cap.
    index('campaign_job_org_status_idx').on(table.signalstackOrgId, table.status, table.createdAt),
    // Watchdog scan for stalled processing jobs.
    index('campaign_job_status_progress_idx').on(table.status, table.lastProgressAt),
  ],
);

export const campaignJobItem = pgTable(
  'campaign_job_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => campaignJob.id, { onDelete: 'cascade' }),
    // Mirrors the parent job's channel so item-level queries (and the
    // cross-job dedup sweep) don't need a join. Set once at insert.
    channel: campaignChannelEnum('channel').notNull(),
    itemId: uuid('item_id').notNull(),
    // The channel action being applied to the item (email/voice); NULL for
    // export (there is no per-item action), which turns OFF the active-dedup
    // constraint below for exports.
    action: text('action'),
    status: campaignJobItemStatusEnum('status').notNull().default('pending'),
    // Provider linkage — the external id this item produced, so an async
    // outcome can be reconciled back to the row (voice: Raya call id +
    // batch id + last polled status; email: message id).
    providerRef: text('provider_ref'),
    rayaBatchId: text('raya_batch_id'),
    lastProviderStatus: text('last_provider_status'),
    // Why the item skipped or failed, and how many handler attempts it took.
    skipReason: text('skip_reason'),
    errorReason: text('error_reason'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Stamped when the item reaches a terminal status.
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    // Derived-count + item-listing lookups.
    index('campaign_job_item_job_status_idx').on(table.jobId, table.status),
    // One row per item per job — makes the insert idempotent under retry.
    uniqueIndex('campaign_job_item_job_item_unique').on(table.jobId, table.itemId),
    // Item-level active dedup: the same (item, action) can't be in flight twice
    // across jobs. Only in-flight/succeeded rows count, and only when an action
    // is present — so exports (action IS NULL) are never deduplicated.
    uniqueIndex('campaign_job_item_active_dedup')
      .on(table.itemId, table.action)
      .where(sql`status IN ('pending','resolved','submitted') AND action IS NOT NULL`),
  ],
);

/**
 * Append-only audit of every campaign action that RELEASES DATA (#617).
 *
 * Deliberately separate from `campaign_job` / `campaign_job_item`: those are
 * mutable, derive counts and are subject to cleanup; this is immutable and
 * outlives them, including the exported S3 object which auto-deletes. Joined by
 * `correlation_id = campaign_job.id`.
 *
 * NEVER stores a participant PII value — field NAMES and counts only. The only
 * identities here are operators (the coordinator, the export-link recipient).
 *
 * Status/list GET routes are NOT audited: the rule is data release, not API
 * traffic. Clients poll every 5-10s, which would bury the real events.
 */
export const campaignPiiAudit = pgTable(
  'campaign_pii_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // = campaign_job.id. For a dump there is no job, so a uuid is generated per
    // request; the column stays NOT NULL and still groups the row.
    correlationId: uuid('correlation_id').notNull(),
    event: campaignAuditEventEnum('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // ── Who ────────────────────────────────────────────────────────────────
    actorUserId: text('actor_user_id'),
    // NULL for a dump, and that null is MEANINGFUL: it is the signature of a
    // whole-network access by the system account, which has no org.
    actorOrgId: text('actor_org_id'),
    actorAzp: text('actor_azp'),
    // Export-link recipient — an operator address, never a participant's.
    recipientRef: text('recipient_ref'),

    // ── What ───────────────────────────────────────────────────────────────
    channel: campaignAuditChannelEnum('channel').notNull(),
    // PII field NAMES, never values. Empty array on a dump asserts positively
    // that no PII field was released ("none, and we checked" vs null's "unknown").
    piiFields: text('pii_fields').array(),
    itemCount: integer('item_count'),

    // ── When ───────────────────────────────────────────────────────────────
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // ── Where ──────────────────────────────────────────────────────────────
    destination: text('destination'),
    network: text('network'),
    instance: text('instance'),
    requestIp: text('request_ip'),

    // ── Why ────────────────────────────────────────────────────────────────
    purpose: text('purpose'),
    // Consent storage/gating is specced separately; present but unused.
    consentRef: text('consent_ref'),

    // ── How ────────────────────────────────────────────────────────────────
    endpoint: text('endpoint'),
    traceId: text('trace_id'),
    outcome: campaignAuditOutcomeEnum('outcome'),
    errorCode: text('error_code'),

    // ── How many ───────────────────────────────────────────────────────────
    requestedCount: integer('requested_count'),
    resolvedCount: integer('resolved_count'),
    skippedCount: integer('skipped_count'),
    failedCount: integer('failed_count'),
    sentCount: integer('sent_count'),

    // Non-PII extras. A dump carries { files, bytes } here rather than adding
    // dump-only columns.
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('campaign_pii_audit_org_created_idx').on(table.actorOrgId, table.createdAt),
    index('campaign_pii_audit_correlation_idx').on(table.correlationId),
    index('campaign_pii_audit_channel_created_idx').on(table.channel, table.createdAt),
  ],
);

// ─── Inferred row types ──────────────────────────────────────────────────────

export type AggregatorRow = typeof aggregators.$inferSelect;
export type NewAggregatorRow = typeof aggregators.$inferInsert;
export type AggregatorOrgRow = typeof aggregatorOrgs.$inferSelect;
export type NewAggregatorOrgRow = typeof aggregatorOrgs.$inferInsert;
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
export type CampaignJob = typeof campaignJob.$inferSelect;
export type NewCampaignJob = typeof campaignJob.$inferInsert;
export type CampaignJobItem = typeof campaignJobItem.$inferSelect;
export type NewCampaignJobItem = typeof campaignJobItem.$inferInsert;

/**
 * Inferred select type for a single `aggregator_consent_record` row.
 *
 * Used by the consent-ledger service and any query helper that reads
 * from the table — import from `@aggregator-dpg/db-schema`.
 */
export type AggregatorConsentRecord = typeof aggregatorConsentRecord.$inferSelect;

/** Inferred insert type for `aggregator_consent_record` (all required fields; `id` and `created_at` have DB defaults). */
export type NewAggregatorConsentRecord = typeof aggregatorConsentRecord.$inferInsert;
