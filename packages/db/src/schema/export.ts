/**
 * Drizzle schema for export_job table.
 *
 * Tracks async data export requests initiated by an aggregator.
 * The file_url is populated once the job completes and the CSV has been
 * uploaded to object storage.
 *
 * @module @aggregator-dpg/db/schema
 */

import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { aggregatorProfile } from './aggregator.js';

/** Lifecycle state of an async export job. */
export const exportJobStatusEnum = pgEnum('export_job_status', [
  'pending',
  'processing',
  'completed',
  'failed',
]);

/**
 * Async export jobs initiated by an aggregator.
 *
 * FK aggregator_id → aggregator_profile.aggregator_id ON DELETE RESTRICT.
 * file_url is null until the job reaches 'completed' status.
 * filter_json captures the query parameters used to scope the export.
 */
export const exportJob = pgTable(
  'export_job',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** FK → aggregator_profile.aggregator_id; RESTRICT on delete. */
    aggregatorId: uuid('aggregator_id')
      .notNull()
      .references(() => aggregatorProfile.aggregatorId, { onDelete: 'restrict' }),
    /** Serialised filter/query parameters that define the export scope. */
    filterJson: jsonb('filter_json').notNull(),
    status: exportJobStatusEnum('status').notNull().default('pending'),
    /** Signed URL to the completed export file; null until status = 'completed'. */
    fileUrl: text('file_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    /** List queries for findByAggregator(), newest-first. */
    aggregatorCreatedIdx: index('idx_export_job_aggregator_created').on(
      t.aggregatorId,
      t.createdAt.desc(),
    ),
    /** Partial index for worker polling on pending jobs. */
    pendingIdx: index('idx_export_job_pending')
      .on(t.createdAt.desc())
      .where(sql`${t.status} = 'pending'`),
  }),
);
