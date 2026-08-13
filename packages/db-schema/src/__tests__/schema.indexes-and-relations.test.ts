/**
 * Index, unique-constraint, and foreign-key regression tests for every
 * `pgTable` in `schema.ts`.
 *
 * Drizzle's `pgTable(name, columns, (table) => ({...}))` third argument
 * (the index/constraint builder) and a column's `.references(() => other.id)`
 * callback are both stored lazily and only invoked when something calls
 * `getTableConfig()` (or drizzle-kit's migration generator does, in
 * production). Merely importing `schema.ts` executes the columns and enums
 * but never runs those callback bodies — which is exactly why
 * `schema.ts`'s function coverage was ~8% despite every table "loading"
 * fine. Calling `getTableConfig(table)` here — and, for foreign keys,
 * calling `.reference()` on the result — both exercises those callback
 * bodies for coverage *and* asserts real facts a future refactor could
 * break: index names/columns/uniqueness, partial-index predicates, and
 * which table+column a foreign key actually points at.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  aggregators,
  aggregatorOrgs,
  aggregatorProfile,
  bulkUploads,
  registrationLinks,
  participants,
  linkSubmissions,
  aggregatorConsentRecord,
  onboarding,
} from '../schema.js';

/** Extracts the SQL column name for an index-column entry that is a plain column (not a SQL expression like `lower(x)`). */
function colName(entry: unknown): string | undefined {
  return typeof entry === 'object' && entry !== null && 'name' in entry
    ? (entry as { name?: string }).name
    : undefined;
}

describe('aggregators: indexes + foreign key', () => {
  const cfg = getTableConfig(aggregators);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('aggregators');
  });

  it('has the two login-lookup unique indexes and the two filter indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['aggregators_contact_phone_unique'].config.unique).toBe(true);
    expect(byName['aggregators_contact_phone_unique'].config.columns.map(colName)).toEqual([
      'contact_phone',
    ]);

    expect(byName['aggregators_contact_email_unique'].config.unique).toBe(true);
    expect(byName['aggregators_contact_email_unique'].config.columns.map(colName)).toEqual([
      'contact_email',
    ]);

    expect(byName['aggregators_status_idx'].config.unique).toBe(false);
    expect(byName['aggregators_status_idx'].config.columns.map(colName)).toEqual(['status']);

    expect(byName['aggregators_actor_type_idx'].config.unique).toBe(false);
    expect(byName['aggregators_actor_type_idx'].config.columns.map(colName)).toEqual([
      'actor_type',
    ]);

    expect(cfg.indexes).toHaveLength(4);
  });

  it('parent_org_id FK points at aggregator_orgs.id with no cascade action', () => {
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(aggregators.parentOrgId);
    expect(ref.foreignTable).toBe(aggregatorOrgs);
    expect(ref.foreignColumns[0]).toBe(aggregatorOrgs.id);
    expect(fk.onDelete).toBe('no action');
  });
});

describe('aggregator_orgs: indexes (not covered by aggregator-orgs.schema.test.ts)', () => {
  const cfg = getTableConfig(aggregatorOrgs);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('aggregator_orgs');
  });

  it('has plain filter indexes on status and owner_email', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['aggregator_orgs_status_idx'].config.unique).toBe(false);
    expect(byName['aggregator_orgs_status_idx'].config.columns.map(colName)).toEqual(['status']);

    expect(byName['aggregator_orgs_owner_email_idx'].config.unique).toBe(false);
    expect(byName['aggregator_orgs_owner_email_idx'].config.columns.map(colName)).toEqual([
      'owner_email',
    ]);
  });

  it('slug uniqueness is a partial unique index scoped to non-terminal rows', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'aggregator_orgs_slug_active_unique');
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['slug']);
    // Partial index: only active/pending rows block a slug reuse (spec A9).
    expect(idx?.config.where).toBeDefined();
  });

  it('display_name uniqueness is case-insensitive and scoped to non-terminal rows', () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === 'aggregator_orgs_display_name_active_unique',
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    // Indexed on `lower(display_name)` — a SQL expression, not a plain column.
    expect(idx?.config.where).toBeDefined();
    expect(cfg.indexes).toHaveLength(4);
  });
});

describe('aggregator_profile: indexes + foreign key', () => {
  const cfg = getTableConfig(aggregatorProfile);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('aggregator_profile');
  });

  it('has GIN indexes on personas/services for Beckn catalog discovery', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['aggregator_profile_personas_gin'].config.method).toBe('gin');
    expect(byName['aggregator_profile_personas_gin'].config.columns.map(colName)).toEqual([
      'personas',
    ]);

    expect(byName['aggregator_profile_services_gin'].config.method).toBe('gin');
    expect(byName['aggregator_profile_services_gin'].config.columns.map(colName)).toEqual([
      'services',
    ]);

    expect(byName['aggregator_profile_completed_at_idx'].config.method).toBe('btree');
    expect(cfg.indexes).toHaveLength(3);
  });

  it('aggregator_id FK cascades on delete of the parent aggregator', () => {
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(aggregatorProfile.aggregatorId);
    expect(ref.foreignTable).toBe(aggregators);
    expect(ref.foreignColumns[0]).toBe(aggregators.id);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('bulk_uploads: indexes + foreign key', () => {
  const cfg = getTableConfig(bulkUploads);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('bulk_uploads');
  });

  it('has the watchdog and per-aggregator-cap composite indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));

    expect(byName['bulk_uploads_status_progress_idx'].config.columns.map(colName)).toEqual([
      'status',
      'last_progress_at',
    ]);
    expect(byName['bulk_uploads_aggregator_status_idx'].config.columns.map(colName)).toEqual([
      'aggregator_id',
      'status',
    ]);
    expect(cfg.indexes).toHaveLength(2);
  });

  it('aggregator_id FK cascades on delete of the parent aggregator', () => {
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(bulkUploads.aggregatorId);
    expect(ref.foreignTable).toBe(aggregators);
    expect(ref.foreignColumns[0]).toBe(aggregators.id);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('registration_links: indexes + foreign key', () => {
  const cfg = getTableConfig(registrationLinks);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('registration_links');
  });

  it('slug uniqueness is scoped per aggregator (two aggregators may share a slug)', () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === 'registration_links_aggregator_slug_unique',
    );
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['aggregator_id', 'slug']);
  });

  it('has a non-unique status filter index', () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === 'registration_links_aggregator_status_idx',
    );
    expect(idx?.config.unique).toBe(false);
    expect(idx?.config.columns.map(colName)).toEqual(['aggregator_id', 'status']);
    expect(cfg.indexes).toHaveLength(2);
  });

  it('aggregator_id FK cascades on delete of the parent aggregator', () => {
    const fk = cfg.foreignKeys[0]!;
    const ref = fk.reference();
    expect(ref.columns[0]).toBe(registrationLinks.aggregatorId);
    expect(ref.foreignTable).toBe(aggregators);
    expect(ref.foreignColumns[0]).toBe(aggregators.id);
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('participants: indexes + foreign keys', () => {
  const cfg = getTableConfig(participants);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('participants');
  });

  it('dedup key includes type so seeker/provider can share an external id', () => {
    const idx = cfg.indexes.find(
      (i) => i.config.name === 'participants_aggregator_type_participant_unique',
    );
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['aggregator_id', 'type', 'participant_id']);
  });

  it('has phone/source-bulk/source-link lookup indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['participants_aggregator_phone_idx'].config.columns.map(colName)).toEqual([
      'aggregator_id',
      'phone',
    ]);
    expect(byName['participants_source_bulk_idx'].config.columns.map(colName)).toEqual([
      'source_bulk_upload_id',
    ]);
    expect(byName['participants_source_link_idx'].config.columns.map(colName)).toEqual([
      'source_link_id',
    ]);
    expect(cfg.indexes).toHaveLength(4);
  });

  it('three foreign keys: aggregator (cascade), source bulk upload + link (set null)', () => {
    expect(cfg.foreignKeys).toHaveLength(3);
    const byColumn = new Map(cfg.foreignKeys.map((fk) => [fk.reference().columns[0], fk]));

    const aggregatorFk = byColumn.get(participants.aggregatorId);
    const aggregatorRef = aggregatorFk?.reference();
    expect(aggregatorRef?.foreignTable).toBe(aggregators);
    expect(aggregatorRef?.foreignColumns[0]).toBe(aggregators.id);
    expect(aggregatorFk?.onDelete).toBe('cascade');

    const bulkFk = byColumn.get(participants.sourceBulkUploadId);
    const bulkRef = bulkFk?.reference();
    expect(bulkRef?.foreignTable).toBe(bulkUploads);
    expect(bulkRef?.foreignColumns[0]).toBe(bulkUploads.id);
    expect(bulkFk?.onDelete).toBe('set null');

    const linkFk = byColumn.get(participants.sourceLinkId);
    const linkRef = linkFk?.reference();
    expect(linkRef?.foreignTable).toBe(registrationLinks);
    expect(linkRef?.foreignColumns[0]).toBe(registrationLinks.id);
    expect(linkFk?.onDelete).toBe('set null');
  });
});

describe('link_submissions: indexes + foreign keys', () => {
  const cfg = getTableConfig(linkSubmissions);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('link_submissions');
  });

  it('has the metrics-rollup pickup index and per-link/per-aggregator indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['link_submissions_rollup_pickup_idx'].config.columns.map(colName)).toEqual([
      'rolled_up_at',
      'created_at',
    ]);
    expect(byName['link_submissions_link_idx'].config.columns.map(colName)).toEqual(['link_id']);
    expect(byName['link_submissions_aggregator_created_idx'].config.columns.map(colName)).toEqual([
      'aggregator_id',
      'created_at',
    ]);
    expect(cfg.indexes).toHaveLength(3);
  });

  it('three foreign keys: link + aggregator (cascade), participant (set null)', () => {
    expect(cfg.foreignKeys).toHaveLength(3);
    const byColumn = new Map(cfg.foreignKeys.map((fk) => [fk.reference().columns[0], fk]));

    const linkFk = byColumn.get(linkSubmissions.linkId);
    const linkRef = linkFk?.reference();
    expect(linkRef?.foreignTable).toBe(registrationLinks);
    expect(linkRef?.foreignColumns[0]).toBe(registrationLinks.id);
    expect(linkFk?.onDelete).toBe('cascade');

    const aggregatorFk = byColumn.get(linkSubmissions.aggregatorId);
    const aggregatorRef = aggregatorFk?.reference();
    expect(aggregatorRef?.foreignTable).toBe(aggregators);
    expect(aggregatorRef?.foreignColumns[0]).toBe(aggregators.id);
    expect(aggregatorFk?.onDelete).toBe('cascade');

    const participantFk = byColumn.get(linkSubmissions.participantId);
    const participantRef = participantFk?.reference();
    expect(participantRef?.foreignTable).toBe(participants);
    expect(participantRef?.foreignColumns[0]).toBe(participants.id);
    expect(participantFk?.onDelete).toBe('set null');
  });
});

describe('aggregator_consent_record: index', () => {
  const cfg = getTableConfig(aggregatorConsentRecord);

  it('table name is snake_case and has no foreign keys (polymorphic subject)', () => {
    expect(cfg.name).toBe('aggregator_consent_record');
    expect(cfg.foreignKeys).toHaveLength(0);
  });

  it('has the ledger lookup index on (subject_type, subject_id)', () => {
    expect(cfg.indexes).toHaveLength(1);
    const idx = cfg.indexes[0]!;
    expect(idx.config.name).toBe('aggregator_consent_record_subject_idx');
    expect(idx.config.unique).toBe(false);
    expect(idx.config.columns.map(colName)).toEqual(['subject_type', 'subject_id']);
  });
});

describe('onboarding: indexes + foreign keys', () => {
  const cfg = getTableConfig(onboarding);

  it('table name is snake_case', () => {
    expect(cfg.name).toBe('onboarding');
  });

  it('bulk rows are unique per batch_id, scoped to source=bulk', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'onboarding_bulk_batch_unique');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['batch_id']);
    expect(idx?.config.where).toBeDefined();
  });

  it('link rows are unique per (aggregator, link, period_start), scoped to source=link', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'onboarding_link_rollup_unique');
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map(colName)).toEqual(['aggregator_id', 'link_id', 'period_start']);
    expect(idx?.config.where).toBeDefined();
  });

  it('has the non-unique aggregator-source-period and batch lookup indexes', () => {
    const byName = Object.fromEntries(cfg.indexes.map((i) => [i.config.name, i]));
    expect(byName['onboarding_aggregator_source_idx'].config.columns.map(colName)).toEqual([
      'aggregator_id',
      'source',
      'period_start',
    ]);
    expect(byName['onboarding_batch_idx'].config.unique).toBe(false);
    expect(byName['onboarding_batch_idx'].config.columns.map(colName)).toEqual(['batch_id']);
    expect(cfg.indexes).toHaveLength(4);
  });

  it('two foreign keys: aggregator (cascade), link (set null)', () => {
    expect(cfg.foreignKeys).toHaveLength(2);
    const byColumn = new Map(cfg.foreignKeys.map((fk) => [fk.reference().columns[0], fk]));

    const aggregatorFk = byColumn.get(onboarding.aggregatorId);
    const aggregatorRef = aggregatorFk?.reference();
    expect(aggregatorRef?.foreignTable).toBe(aggregators);
    expect(aggregatorRef?.foreignColumns[0]).toBe(aggregators.id);
    expect(aggregatorFk?.onDelete).toBe('cascade');

    const linkFk = byColumn.get(onboarding.linkId);
    const linkRef = linkFk?.reference();
    expect(linkRef?.foreignTable).toBe(registrationLinks);
    expect(linkRef?.foreignColumns[0]).toBe(registrationLinks.id);
    expect(linkFk?.onDelete).toBe('set null');
  });
});
