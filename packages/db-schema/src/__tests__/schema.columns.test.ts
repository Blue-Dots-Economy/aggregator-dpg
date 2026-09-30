/**
 * Column-shape regression tests for every `pgTable` in `schema.ts` that
 * isn't already covered by `aggregator-orgs.schema.test.ts` or
 * `schema.test.ts`.
 *
 * There is no business logic in a Drizzle table definition to exercise —
 * the meaningful assertion is that each exported column keeps its expected
 * SQL name, nullability, default-presence, primary-key/generated-column
 * status, and Postgres column type. If someone renames a column, flips a
 * `.notNull()`, or removes a `.generatedAlwaysAs()`, these tests fail
 * instead of silently drifting from the migrations that were generated
 * from this file.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import {
  aggregators,
  aggregatorOrgs,
  bulkUploads,
  registrationLinks,
  linkSubmissions,
  aggregatorConsentRecord,
  onboarding,
} from '../schema.js';

describe('aggregators columns', () => {
  it('identity + lifecycle columns', () => {
    expect(aggregators.id.name).toBe('id');
    expect(aggregators.id.primary).toBe(true);
    expect(aggregators.id.hasDefault).toBe(true);
    expect(aggregators.id.columnType).toBe('PgUUID');

    expect(aggregators.orgSlug.name).toBe('org_slug');
    expect(aggregators.orgSlug.notNull).toBe(true);
    expect(aggregators.orgSlug.isUnique).toBe(true);

    expect(aggregators.actorType.name).toBe('actor_type');
    expect(aggregators.actorType.notNull).toBe(true);
    expect(aggregators.actorType.columnType).toBe('PgEnumColumn');

    expect(aggregators.name.name).toBe('name');
    expect(aggregators.name.notNull).toBe(true);

    // `type` is nullable — enforced via a CHECK constraint in the migration,
    // not at the Drizzle column level.
    expect(aggregators.type.name).toBe('type');
    expect(aggregators.type.notNull).toBe(false);

    expect(aggregators.url.name).toBe('url');
    expect(aggregators.url.notNull).toBe(false);

    expect(aggregators.status.name).toBe('status');
    expect(aggregators.status.notNull).toBe(true);
    expect(aggregators.status.hasDefault).toBe(true);

    expect(aggregators.createdBy.name).toBe('created_by');
    expect(aggregators.createdBy.notNull).toBe(true);
    expect(aggregators.updatedBy.name).toBe('updated_by');
    expect(aggregators.updatedBy.notNull).toBe(true);

    expect(aggregators.createdAt.name).toBe('created_at');
    expect(aggregators.createdAt.notNull).toBe(true);
    expect(aggregators.createdAt.hasDefault).toBe(true);
    expect(aggregators.updatedAt.name).toBe('updated_at');
    expect(aggregators.updatedAt.notNull).toBe(true);
    expect(aggregators.updatedAt.hasDefault).toBe(true);

    expect(aggregators.signalstackOrgId.name).toBe('signalstack_org_id');
    expect(aggregators.signalstackOrgId.notNull).toBe(false);
  });

  it('contact FK + contact_extra (migration 0025)', () => {
    expect(aggregators.contactId.name).toBe('contact_id');
    expect(aggregators.contactId.notNull).toBe(false);
    expect(aggregators.contactExtra.name).toBe('contact_extra');
    expect(aggregators.contactExtra.notNull).toBe(true);
    expect(aggregators.contactExtra.hasDefault).toBe(true);
  });

  it('LEGACY Beckn contact jsonb + the generated login-lookup columns (nullable since 0025)', () => {
    expect(aggregators.contact.name).toBe('contact');
    expect(aggregators.contact.notNull).toBe(false);
    expect(aggregators.contact.columnType).toBe('PgJsonb');

    // Generated columns: derived from `contact` via a stored SQL expression,
    // never written directly. They exist purely for indexed login lookups.
    expect(aggregators.contactPhone.name).toBe('contact_phone');
    expect(aggregators.contactPhone.notNull).toBe(false);
    expect(aggregators.contactPhone.generated).toBeTruthy();
    expect(aggregators.contactPhone.generated?.type).toBe('always');
    expect(aggregators.contactPhone.generated?.mode).toBe('stored');

    expect(aggregators.contactEmail.name).toBe('contact_email');
    expect(aggregators.contactEmail.notNull).toBe(false);
    expect(aggregators.contactEmail.generated).toBeTruthy();
    expect(aggregators.contactEmail.generated?.type).toBe('always');
    expect(aggregators.contactEmail.generated?.mode).toBe('stored');
  });

  it('locations + consent jsonb columns', () => {
    expect(aggregators.locations.name).toBe('locations');
    expect(aggregators.locations.notNull).toBe(true);
    expect(aggregators.locations.hasDefault).toBe(true);

    expect(aggregators.consent.name).toBe('consent');
    expect(aggregators.consent.notNull).toBe(true);
    expect(aggregators.consent.hasDefault).toBe(false);
  });
});

describe('aggregator_orgs remaining columns (not covered by aggregator-orgs.schema.test.ts)', () => {
  it('owner_phone is a nullable text column', () => {
    expect(aggregatorOrgs.ownerPhone.name).toBe('owner_phone');
    expect(aggregatorOrgs.ownerPhone.notNull).toBe(false);
  });

  it('contact_id FK column and the legacy owner_email relaxed to nullable (0025)', () => {
    expect(aggregatorOrgs.contactId.name).toBe('contact_id');
    expect(aggregatorOrgs.contactId.notNull).toBe(false);
    expect(aggregatorOrgs.ownerEmail.notNull).toBe(false);
  });

  it('id is a defaulted primary key', () => {
    expect(aggregatorOrgs.id.name).toBe('id');
    expect(aggregatorOrgs.id.primary).toBe(true);
    expect(aggregatorOrgs.id.hasDefault).toBe(true);
  });
});

describe('bulk_uploads columns', () => {
  it('lifecycle + counters', () => {
    expect(bulkUploads.id.primary).toBe(true);
    expect(bulkUploads.aggregatorId.name).toBe('aggregator_id');
    expect(bulkUploads.aggregatorId.notNull).toBe(true);

    expect(bulkUploads.participantType.name).toBe('participant_type');
    expect(bulkUploads.participantType.notNull).toBe(true);

    expect(bulkUploads.s3Key.name).toBe('s3_key');
    expect(bulkUploads.s3Key.notNull).toBe(true);
    // ETag is NULL while status='pending' — cannot be notNull.
    expect(bulkUploads.s3Etag.name).toBe('s3_etag');
    expect(bulkUploads.s3Etag.notNull).toBe(false);

    expect(bulkUploads.status.name).toBe('status');
    expect(bulkUploads.status.notNull).toBe(true);
    expect(bulkUploads.status.hasDefault).toBe(true);

    expect(bulkUploads.schemaId.name).toBe('schema_id');
    expect(bulkUploads.schemaId.notNull).toBe(true);
    expect(bulkUploads.schemaVersion.name).toBe('schema_version');
    expect(bulkUploads.schemaVersion.notNull).toBe(true);

    expect(bulkUploads.uploadedBy.name).toBe('uploaded_by');
    expect(bulkUploads.uploadedBy.notNull).toBe(true);

    expect(bulkUploads.lastProgressAt.name).toBe('last_progress_at');
    expect(bulkUploads.lastProgressAt.notNull).toBe(false);
    expect(bulkUploads.completedAt.name).toBe('completed_at');
    expect(bulkUploads.completedAt.notNull).toBe(false);
  });
});

describe('registration_links remaining columns', () => {
  it('domain/context/status/expiry/audit columns', () => {
    expect(registrationLinks.aggregatorId.name).toBe('aggregator_id');
    expect(registrationLinks.aggregatorId.notNull).toBe(true);

    expect(registrationLinks.slug.name).toBe('slug');
    expect(registrationLinks.slug.notNull).toBe(true);

    expect(registrationLinks.domain.name).toBe('domain');
    expect(registrationLinks.domain.notNull).toBe(true);

    expect(registrationLinks.context.name).toBe('context');
    expect(registrationLinks.context.notNull).toBe(true);
    expect(registrationLinks.context.hasDefault).toBe(true);

    expect(registrationLinks.qrObjectKey.name).toBe('qr_object_key');
    expect(registrationLinks.qrObjectKey.notNull).toBe(false);

    expect(registrationLinks.status.name).toBe('status');
    expect(registrationLinks.status.notNull).toBe(true);
    expect(registrationLinks.status.hasDefault).toBe(true);

    expect(registrationLinks.expiresAt.name).toBe('expires_at');
    expect(registrationLinks.expiresAt.notNull).toBe(false);

    expect(registrationLinks.createdBy.name).toBe('created_by');
    expect(registrationLinks.createdBy.notNull).toBe(true);
  });
});

describe('link_submissions columns', () => {
  it('outcome + snapshot payload columns', () => {
    expect(linkSubmissions.linkId.name).toBe('link_id');
    expect(linkSubmissions.linkId.notNull).toBe(true);

    expect(linkSubmissions.aggregatorId.name).toBe('aggregator_id');
    expect(linkSubmissions.aggregatorId.notNull).toBe(true);

    expect(linkSubmissions.metadataSnapshot.name).toBe('metadata_snapshot');
    expect(linkSubmissions.metadataSnapshot.notNull).toBe(true);
    expect(linkSubmissions.metadataSnapshot.hasDefault).toBe(true);

    expect(linkSubmissions.submittedData.name).toBe('submitted_data');
    expect(linkSubmissions.submittedData.notNull).toBe(true);
    expect(linkSubmissions.submittedData.hasDefault).toBe(true);

    expect(linkSubmissions.outcome.name).toBe('outcome');
    expect(linkSubmissions.outcome.notNull).toBe(true);
    expect(linkSubmissions.outcome.hasDefault).toBe(false);
    expect(linkSubmissions.outcome.columnType).toBe('PgEnumColumn');

    expect(linkSubmissions.rolledUpAt.name).toBe('rolled_up_at');
    expect(linkSubmissions.rolledUpAt.notNull).toBe(false);
  });
});

describe('aggregator_consent_record columns', () => {
  it('polymorphic subject + versioned consent columns', () => {
    expect(aggregatorConsentRecord.id.primary).toBe(true);

    expect(aggregatorConsentRecord.subjectType.name).toBe('subject_type');
    expect(aggregatorConsentRecord.subjectType.notNull).toBe(true);

    expect(aggregatorConsentRecord.subjectId.name).toBe('subject_id');
    expect(aggregatorConsentRecord.subjectId.notNull).toBe(true);

    expect(aggregatorConsentRecord.termsVersion.name).toBe('terms_version');
    expect(aggregatorConsentRecord.termsVersion.notNull).toBe(true);
    expect(aggregatorConsentRecord.termsVersion.columnType).toBe('PgInteger');

    expect(aggregatorConsentRecord.privacyVersion.name).toBe('privacy_version');
    expect(aggregatorConsentRecord.privacyVersion.notNull).toBe(true);

    expect(aggregatorConsentRecord.network.name).toBe('network');
    expect(aggregatorConsentRecord.network.notNull).toBe(true);

    // Nullable — the network-default registration has no brand override.
    expect(aggregatorConsentRecord.brand.name).toBe('brand');
    expect(aggregatorConsentRecord.brand.notNull).toBe(false);

    expect(aggregatorConsentRecord.source.name).toBe('source');
    expect(aggregatorConsentRecord.source.notNull).toBe(true);

    // Server-stamped at accept time — no DB default, the app supplies it.
    expect(aggregatorConsentRecord.acceptedAt.name).toBe('accepted_at');
    expect(aggregatorConsentRecord.acceptedAt.notNull).toBe(true);
    expect(aggregatorConsentRecord.acceptedAt.hasDefault).toBe(false);

    expect(aggregatorConsentRecord.createdAt.name).toBe('created_at');
    expect(aggregatorConsentRecord.createdAt.hasDefault).toBe(true);
  });
});

describe('onboarding columns', () => {
  it('period window + rollup counters', () => {
    expect(onboarding.aggregatorId.name).toBe('aggregator_id');
    expect(onboarding.aggregatorId.notNull).toBe(true);

    expect(onboarding.orgSlug.name).toBe('org_slug');
    expect(onboarding.orgSlug.notNull).toBe(true);

    expect(onboarding.source.name).toBe('source');
    expect(onboarding.source.notNull).toBe(true);
    expect(onboarding.source.columnType).toBe('PgEnumColumn');

    // batch_id / link_id are mutually exclusive by source (bulk vs link);
    // both nullable at the column level, enforced by partial unique indexes.
    expect(onboarding.batchId.name).toBe('batch_id');
    expect(onboarding.batchId.notNull).toBe(false);
    expect(onboarding.linkId.name).toBe('link_id');
    expect(onboarding.linkId.notNull).toBe(false);

    expect(onboarding.periodStart.name).toBe('period_start');
    expect(onboarding.periodStart.notNull).toBe(true);
    expect(onboarding.periodEnd.name).toBe('period_end');
    expect(onboarding.periodEnd.notNull).toBe(true);

    expect(onboarding.total.name).toBe('total');
    expect(onboarding.total.notNull).toBe(true);
    expect(onboarding.total.hasDefault).toBe(false);
    expect(onboarding.total.columnType).toBe('PgInteger');

    expect(onboarding.passed.name).toBe('passed');
    expect(onboarding.passed.notNull).toBe(true);
    expect(onboarding.passed.hasDefault).toBe(true);

    expect(onboarding.failed.name).toBe('failed');
    expect(onboarding.failed.notNull).toBe(true);
    expect(onboarding.failed.hasDefault).toBe(true);

    expect(onboarding.skipped.name).toBe('skipped');
    expect(onboarding.skipped.notNull).toBe(true);
    expect(onboarding.skipped.hasDefault).toBe(true);
  });
});
