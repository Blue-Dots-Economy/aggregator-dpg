/**
 * Drizzle schema for registration_request table.
 *
 * Captures inbound aggregator registration submissions before an admin
 * reviews and approves or rejects them. Not linked to aggregator_profile
 * by FK — an approved request results in a new aggregator_profile row
 * created by the admin workflow.
 *
 * @module @aggregator-dpg/db/schema
 */

import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Lifecycle state of a registration request. */
export const registrationStatusEnum = pgEnum('registration_status', [
  'pending',
  'approved',
  'rejected',
]);

/**
 * Inbound aggregator registration requests awaiting admin review.
 *
 * No FK to aggregator_profile — the profile is created only after approval.
 * consent_at records when the applicant accepted the platform terms.
 */
export const registrationRequest = pgTable('registration_request', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgName: text('org_name').notNull(),
  /** Type of aggregator (e.g. "employer", "skilling-partner"). */
  aggregatorType: text('aggregator_type').notNull(),
  adminName: text('admin_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  /** Timestamp when the applicant accepted the platform terms of service. */
  consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
  status: registrationStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
