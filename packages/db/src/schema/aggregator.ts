/**
 * Drizzle schema for aggregator profile tables.
 *
 * aggregator_profile_schema — versioned JSON schema definitions used to
 *   validate aggregator profile data. Multiple versions can coexist; only
 *   one is active at a time.
 *
 * aggregator_profile — one row per aggregator, storing profile values
 *   validated against a specific schema version.
 *
 * @module @aggregator-dpg/db/schema
 */

import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Versioned JSON schema definitions for aggregator profile forms.
 *
 * ON DELETE: rows are RESTRICT-protected via the FK on aggregator_profile —
 * a schema version in use cannot be deleted.
 */
export const aggregatorProfileSchema = pgTable(
  'aggregator_profile_schema',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Monotonic version label (e.g. "1", "2"). */
    version: text('version').notNull(),
    /** Full JSON Schema document describing the profile form. */
    schemaJson: jsonb('schema_json').notNull(),
    /** Only one row should be active at a time; enforced at application layer. */
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** Partial index supporting findActive() — sub-ms lookup of the current active schema. */
    activeIdx: index('idx_aggregator_profile_schema_active')
      .on(t.createdAt.desc())
      .where(sql`${t.active} = true`),
  }),
);

/**
 * One profile per aggregator organisation.
 *
 * aggregator_id is the stable UUID identity for an aggregator across all
 * downstream tables. All other tables FK → aggregator_profile.aggregator_id.
 *
 * ON DELETE: audit_log and registration_request rows reference aggregator_id
 * with RESTRICT semantics — an aggregator cannot be deleted while records
 * exist. Use application-level soft-delete (e.g. a `deactivated_at` column)
 * instead of hard DELETE.
 */
export const aggregatorProfile = pgTable(
  'aggregator_profile',
  {
    aggregatorId: uuid('aggregator_id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK → aggregator_profile_schema.id; RESTRICT on delete. */
    schemaVersion: uuid('schema_version')
      .notNull()
      .references(() => aggregatorProfileSchema.id, { onDelete: 'restrict' }),
    /** Profile field values, validated against the referenced schema version. */
    valuesJson: jsonb('values_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** FK lookup for findBySchemaVersion() — enumerates aggregators on a given schema. */
    schemaVersionIdx: index('idx_aggregator_profile_schema_version').on(t.schemaVersion),
  }),
);
