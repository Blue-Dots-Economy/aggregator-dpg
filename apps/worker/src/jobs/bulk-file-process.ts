/**
 * Bulk File Processor — file-level checks before per-row work begins.
 *
 * Per onboarding-implementation.md §3.2:
 *   1. Download CSV from S3.
 *   2. Reject non-UTF-8 (BOM check).
 *   3. Parse header, validate against the active JSON Schema for the
 *      participant_type. Reject on missing required cols / unknown cols.
 *   4. Count rows; reject 0-row, > BULK_MAX_ROWS, or any row > 64KB.
 *   5. Update bulk_uploads.status = 'row_processing', set total_rows.
 *   6. Enqueue per-row jobs into the bulk-row-process queue (slice 11).
 *
 * Failure path: bulk_uploads.status = 'file_failed' + status_reason set.
 * No row jobs enqueued.
 *
 * Idempotency: Lua-free at this stage. Replays re-download + re-parse;
 * status is guarded so a row_processing or completed upload short-circuits.
 */

import Papa from 'papaparse';
import { eq } from 'drizzle-orm';
import type { BulkFileProcessJob } from '@aggregator-dpg/queue';
import { FileSchemaLoader } from '@aggregator-dpg/schema-loader/file';
import { schema, getDb } from '../db.js';
import { downloadCsvAsString } from '../object-storage.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const schemaLoader = new FileSchemaLoader({ rootDir: config.SCHEMA_ROOT_DIR });

const BOM = '﻿';

export type FileFailureReason =
  | 'encoding_unsupported'
  | 'header_mismatch'
  | 'empty_csv'
  | 'row_cap_exceeded'
  | 'row_size_exceeded'
  | 'schema_unavailable'
  | 'system_error';

interface ProcessOutcome {
  status: 'enqueued' | 'failed';
  totalRows?: number;
  reason?: FileFailureReason;
  detail?: string;
}

export async function processBulkFile(job: BulkFileProcessJob): Promise<ProcessOutcome> {
  const log = logger.child({
    operation: 'bulkFileProcess',
    upload_id: job.uploadId,
    aggregator_id: job.aggregatorId,
  });
  const start = Date.now();

  // Idempotency guard: short-circuit if already past file_validating.
  const existing = await getDb()
    .select()
    .from(schema.bulkUploads)
    .where(eq(schema.bulkUploads.id, job.uploadId))
    .limit(1);
  const row = existing[0];
  if (!row) {
    log.warn({ status: 'skipped', reason: 'row_missing' });
    return { status: 'failed', reason: 'system_error', detail: 'upload row missing' };
  }
  const TERMINAL_OR_LATER = new Set([
    'row_processing',
    'finalising',
    'completed',
    'failed',
    'file_failed',
  ]);
  if (TERMINAL_OR_LATER.has(row.status)) {
    log.info({ status: 'skipped', reason: 'already_progressed', current_status: row.status });
    return { status: 'enqueued' };
  }

  await markStatus(job.uploadId, 'file_validating', null);

  // 1. Download.
  let body: string;
  try {
    body = await downloadCsvAsString(job.s3Key);
  } catch (err) {
    log.error({ status: 'failure', sub: 's3.get', error: (err as Error).message });
    await markStatus(job.uploadId, 'file_failed', 'system_error');
    return { status: 'failed', reason: 'system_error' };
  }

  // 2. Encoding check (BOM = UTF-8/16/32 marker; we only accept plain UTF-8).
  if (body.startsWith(BOM)) {
    body = body.slice(1); // strip UTF-8 BOM (acceptable; some Excel exports include it)
  }
  // A reliable non-UTF-8 signal: replacement chars (U+FFFD) emitted by toString('utf8').
  if (body.includes('�')) {
    log.warn({ status: 'failure', reason: 'encoding_unsupported' });
    await markStatus(job.uploadId, 'file_failed', 'encoding_unsupported');
    return { status: 'failed', reason: 'encoding_unsupported' };
  }

  // 3. Schema fetch.
  const validatorResult = await schemaLoader.getValidator({
    id: job.schemaId,
    version: job.schemaVersion,
  });
  if (!validatorResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }
  const schemaResult = await schemaLoader.getSchema({
    id: job.schemaId,
    version: job.schemaVersion,
  });
  if (!schemaResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: schemaResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }

  // 4. Parse.
  const parsed = Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  // Header validation.
  const required = extractRequiredFields(schemaResult.value);
  const allowedSet = new Set(extractAllProperties(schemaResult.value));
  const headers = parsed.meta.fields ?? [];
  const headerSet = new Set(headers);
  const missing = required.filter((f) => !headerSet.has(f));
  if (missing.length > 0) {
    log.warn({ status: 'failure', reason: 'header_mismatch', missing });
    await markStatus(job.uploadId, 'file_failed', `header_mismatch: missing ${missing.join(',')}`);
    return { status: 'failed', reason: 'header_mismatch', detail: `missing: ${missing.join(',')}` };
  }
  const unknown = headers.filter((h) => !allowedSet.has(h));
  if (unknown.length > 0) {
    log.warn({ status: 'failure', reason: 'header_mismatch', unknown });
    await markStatus(job.uploadId, 'file_failed', `header_mismatch: unknown ${unknown.join(',')}`);
    return { status: 'failed', reason: 'header_mismatch', detail: `unknown: ${unknown.join(',')}` };
  }

  // Row count + size checks.
  const rows = parsed.data;
  if (rows.length === 0) {
    log.warn({ status: 'failure', reason: 'empty_csv' });
    await markStatus(job.uploadId, 'file_failed', 'empty_csv');
    return { status: 'failed', reason: 'empty_csv' };
  }
  if (rows.length > config.BULK_MAX_ROWS) {
    log.warn({ status: 'failure', reason: 'row_cap_exceeded', rows: rows.length });
    await markStatus(job.uploadId, 'file_failed', `row_cap_exceeded: ${rows.length}`);
    return { status: 'failed', reason: 'row_cap_exceeded' };
  }
  // Row-size cap: re-tokenise the body by newlines to measure per-line bytes.
  const lines = body.split('\n');
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > config.BULK_MAX_ROW_BYTES) {
      log.warn({ status: 'failure', reason: 'row_size_exceeded' });
      await markStatus(job.uploadId, 'file_failed', 'row_size_exceeded');
      return { status: 'failed', reason: 'row_size_exceeded' };
    }
  }

  // 5. Transition to row_processing + record total.
  await getDb()
    .update(schema.bulkUploads)
    .set({
      status: 'row_processing',
      totalRows: rows.length,
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.bulkUploads.id, job.uploadId));

  // 6. TODO(slice 11): enqueue per-row jobs into bulk-row-process here.
  // For now the row jobs aren't wired; the upload will sit in row_processing
  // until slice 11. This is intentional — slice 9 covers file-level only.

  log.info({
    status: 'success',
    latency_ms: Date.now() - start,
    total_rows: rows.length,
  });
  return { status: 'enqueued', totalRows: rows.length };
}

async function markStatus(
  uploadId: string,
  status:
    | 'pending'
    | 'uploaded'
    | 'file_validating'
    | 'file_failed'
    | 'row_processing'
    | 'finalising'
    | 'completed'
    | 'failed',
  reason: string | null,
): Promise<void> {
  await getDb()
    .update(schema.bulkUploads)
    .set({
      status,
      statusReason: reason,
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.bulkUploads.id, uploadId));
}

function extractRequiredFields(s: Record<string, unknown>): string[] {
  const required = s['required'];
  return Array.isArray(required) ? required.filter((x): x is string => typeof x === 'string') : [];
}

function extractAllProperties(s: Record<string, unknown>): string[] {
  const props = s['properties'];
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}
