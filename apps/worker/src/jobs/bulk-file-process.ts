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

import { eq } from 'drizzle-orm';
import type { BulkFileProcessJob } from '@aggregator-dpg/queue';
import { schema, getDb } from '../db.js';
import { getCsvStream } from '../object-storage.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueRowProcessBulk } from '../services/bulk-queue.js';
import { streamCsvParse, type FileFailureReason } from './bulk-file-stream.js';

export type { FileFailureReason };

/** Rows enqueued per BullMQ `addBulk` batch + Redis `:lines` write. */
const ENQUEUE_CHUNK = 1000;

interface ProcessOutcome {
  status: 'enqueued' | 'failed';
  totalRows?: number;
  reason?: FileFailureReason;
  detail?: string;
}

/** Human-readable `status_reason` for a file-level failure, mirroring the
 * previous whole-file implementation's strings. */
function failureReason(reason: FileFailureReason, detail?: string): string {
  if (detail && (reason === 'header_mismatch' || reason === 'row_cap_exceeded')) {
    return `${reason}: ${detail}`;
  }
  return reason;
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

  // 1. Schema fetch — validator + schema in one round-trip (loader caches both).
  const loader = getSchemaLoader();
  const ref = { id: job.schemaId, version: job.schemaVersion };
  const [validatorResult, schemaResult] = await Promise.all([
    loader.getValidator(ref),
    loader.getSchema(ref),
  ]);
  if (!validatorResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }
  if (!schemaResult.success) {
    log.error({ status: 'failure', sub: 'schema.load', error: schemaResult.error.code });
    await markStatus(job.uploadId, 'file_failed', 'schema_unavailable');
    return { status: 'failed', reason: 'schema_unavailable' };
  }

  // 2. Stream-parse the S3 body. The parser consumes the object incrementally
  // (UTF-8 decode → header validation → per-row caps) without buffering the
  // whole file or blocking the event loop. No rows are returned on failure, so
  // a rejected file onboards nothing (atomicity preserved).
  let stream;
  try {
    stream = await getCsvStream(job.s3Key);
  } catch (err) {
    log.error({ status: 'failure', sub: 's3.get', error: (err as Error).message });
    await markStatus(job.uploadId, 'file_failed', 'system_error');
    return { status: 'failed', reason: 'system_error' };
  }

  const required = extractRequiredFields(schemaResult.value);
  const allowed = new Set(extractAllProperties(schemaResult.value));
  const parsed = await streamCsvParse(stream, {
    required,
    allowed,
    maxRows: config.BULK_MAX_ROWS,
    maxRowBytes: config.BULK_MAX_ROW_BYTES,
  });

  if (parsed.status === 'failed') {
    log.warn({ status: 'failure', reason: parsed.reason, detail: parsed.detail });
    await markStatus(job.uploadId, 'file_failed', failureReason(parsed.reason, parsed.detail));
    return {
      status: 'failed',
      reason: parsed.reason,
      ...(parsed.detail !== undefined ? { detail: parsed.detail } : {}),
    };
  }

  const { headers, rows } = parsed;

  // 3. Transition to row_processing. The total row count moves into Redis
  // (see step 4 below) instead of the dropped `bulk_uploads.total_rows`
  // column — keeps `bulk_uploads` as pure lifecycle state.
  await getDb()
    .update(schema.bulkUploads)
    .set({
      status: 'row_processing',
      lastProgressAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.bulkUploads.id, job.uploadId));

  // 4. Enqueue per-row jobs FIRST, then set total + reader_done in Redis.
  // Order matters: setting total before all jobs are enqueued risks the Row
  // Processor seeing `processed == total` early and triggering Finaliser
  // prematurely.
  const redis = getRedis();
  const ns = `bu:${job.uploadId}`;
  // Stash header columns for the Finaliser — it needs them to write
  // errors.csv with matching original-column ordering.
  await redis.hset(
    `${ns}:meta`,
    'started_at',
    String(Date.now()),
    'headers',
    JSON.stringify(headers),
  );

  for (let off = 0; off < rows.length; off += ENQUEUE_CHUNK) {
    const slice = rows.slice(off, off + ENQUEUE_CHUNK);
    const payloads = slice.map((r) => ({
      uploadId: job.uploadId,
      aggregatorId: job.aggregatorId,
      rowIndex: r.rowIndex,
      schemaId: job.schemaId,
      schemaVersion: job.schemaVersion,
      participantType: job.participantType,
      payload: r.payload,
    }));

    // Persist reconstructed CSV lines under bu:{id}:lines so the Finaliser can
    // rebuild errors.csv. The line round-trips through positional re-parse, so
    // the Finaliser's `parseRawRow` recovers the original cells.
    const linesArgs: string[] = [];
    for (const r of slice) {
      linesArgs.push(String(r.rowIndex), r.rawLine);
    }
    if (linesArgs.length > 0) {
      await redis.hset(`${ns}:lines`, ...linesArgs);
    }

    await enqueueRowProcessBulk(payloads);
  }

  // Now safe to publish total_rows + reader_done.
  await redis.hset(`${ns}:meta`, 'total_rows', String(rows.length), 'reader_done', '1');

  log.info({
    status: 'success',
    event_type: 'audit',
    audit: 'bulkUpload.run_started',
    latency_ms: Date.now() - start,
    total_rows: rows.length,
    enqueued: rows.length,
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
