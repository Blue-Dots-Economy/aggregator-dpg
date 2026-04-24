/**
 * Drizzle schema for onboarding_link table.
 *
 * Each onboarding link is a shareable URL or QR code entry point for
 * seekers or providers to register under a specific aggregator.
 *
 * @module @aggregator-dpg/db/schema
 */

import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { aggregatorProfile } from './aggregator.js';

/** Channel through which a user reaches the onboarding flow. */
export const onboardingModeEnum = pgEnum('onboarding_mode', ['link', 'qr', 'bulk']);

/** Whether the link is for a job seeker or a service provider. */
export const targetRoleEnum = pgEnum('target_role', ['seeker', 'provider']);

/**
 * Shareable onboarding entry points created by an aggregator.
 *
 * FK aggregator_id → aggregator_profile.aggregator_id ON DELETE RESTRICT.
 * An aggregator cannot be hard-deleted while active onboarding links exist.
 *
 * Soft-delete via revoked_at: a non-null value means the link is inactive.
 * Expiry via expires_at: null means the link never expires.
 */
export const onboardingLink = pgTable(
  'onboarding_link',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK → aggregator_profile.aggregator_id; RESTRICT on delete. */
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregatorProfile.aggregatorId, { onDelete: 'restrict' }),
    mode: onboardingModeEnum('mode').notNull(),
    targetRole: targetRoleEnum('target_role').notNull(),
    /** Human-readable label shown in the aggregator dashboard. */
    label: text('label').notNull(),
    /** Cumulative count of successful registrations via this link. */
    joinCount: integer('join_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Null means the link never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Non-null means the link has been revoked and is no longer usable. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    /** List queries scoped by aggregator and ordered newest-first. */
    aggregatorCreatedIdx: index('idx_onboarding_link_aggregator_created').on(
      t.aggregatorId,
      t.createdAt.desc(),
    ),
    /** Partial index for findActiveByAggregator() — only non-revoked links. */
    activeByAggregatorIdx: index('idx_onboarding_link_active_aggregator')
      .on(t.aggregatorId, t.createdAt.desc())
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);
