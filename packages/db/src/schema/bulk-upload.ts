/**
 * Drizzle schema for bulk upload tables.
 *
 * bulk_upload_batch — one row per CSV upload job, tracking aggregate counts.
 * bulk_upload_row   — one row per CSV line, tracking per-row outcome.
 *
 * @module @aggregator-dpg/db/schema
 */

import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { aggregatorProfile } from './aggregator.js';

/** Per-row outcome after validation and Signals Stack submission. */
export const bulkUploadRowOutcomeEnum = pgEnum('bulk_upload_row_outcome', [
  'success',
  'flagged',
  'error',
]);

/**
 * Tracks a single CSV bulk-upload job submitted by an aggregator.
 *
 * FK aggregator_id → aggregator_profile.aggregator_id ON DELETE RESTRICT.
 * created_by stores the user/session ID of the operator who triggered the upload.
 */
export const bulkUploadBatch = pgTable('bulk_upload_batch', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** FK → aggregator_profile.aggregator_id; RESTRICT on delete. */
  aggregatorId: uuid('aggregator_id')
    .notNull()
    .references(() => aggregatorProfile.aggregatorId, { onDelete: 'restrict' }),
  /** Original filename of the uploaded CSV. */
  filename: text('filename').notNull(),
  /** Total number of data rows in the CSV (excluding header). */
  total: integer('total').notNull().default(0),
  /** Rows successfully submitted to Signals Stack. */
  succeeded: integer('succeeded').notNull().default(0),
  /** Rows that passed validation but were flagged for manual review. */
  flagged: integer('flagged').notNull().default(0),
  /** User or session ID of the operator who triggered this upload. */
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * Per-row detail for a bulk upload batch.
 *
 * FK batch_id → bulk_upload_batch.id ON DELETE CASCADE.
 * Rows are deleted automatically when the parent batch is deleted.
 */
export const bulkUploadRow = pgTable('bulk_upload_row', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** FK → bulk_upload_batch.id; CASCADE on delete. */
  batchId: uuid('batch_id')
    .notNull()
    .references(() => bulkUploadBatch.id, { onDelete: 'cascade' }),
  /** 1-based row number in the original CSV (excluding header). */
  rowNumber: integer('row_number').notNull(),
  /** Raw parsed row data before validation. */
  rawRowJson: jsonb('raw_row_json').notNull(),
  outcome: bulkUploadRowOutcomeEnum('outcome').notNull(),
  /** Machine-readable error code (null on success). */
  errorCode: text('error_code'),
  /** Human-readable error message (null on success). */
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
