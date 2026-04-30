/**
 * Postgres schema definitions for the Aggregator API.
 *
 * Two-table model:
 *   - `aggregators`: org-level data only (id, slug, type, timestamps).
 *     Created at submit time. Approval state lives in Keycloak via the
 *     `enabled` flag and `aggregator_id` user attribute (reverse pointer).
 *   - `aggregator_profiles`: per-aggregator profile JSON, populated post-login.
 *
 * No PII is stored in Postgres. Email, phone, and contact name live in
 * Keycloak as username, email, and `phoneNumber` user attribute.
 */

import { pgTable, uuid, text, timestamp, jsonb, integer, pgEnum } from 'drizzle-orm/pg-core';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const aggregatorTypeEnum = pgEnum('aggregator_type', ['seeker', 'provider']);

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

// ─── Inferred row types ──────────────────────────────────────────────────────

export type AggregatorRow = typeof aggregators.$inferSelect;
export type NewAggregatorRow = typeof aggregators.$inferInsert;
export type AggregatorProfileRow = typeof aggregatorProfiles.$inferSelect;
export type NewAggregatorProfileRow = typeof aggregatorProfiles.$inferInsert;
