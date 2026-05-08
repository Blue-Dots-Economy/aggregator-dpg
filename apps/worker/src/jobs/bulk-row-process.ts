/**
 * Bulk Row Processor — per-row processing inside the bulk-upload pipeline.
 *
 * Per onboarding-implementation.md §3.3:
 *   1. Pull job { uploadId, aggregatorId, rowIndex, rawRow, payload }.
 *   2. Validate against the schema pinned on bulk_uploads.
 *   3. Normalise phone (E.164) and email (lowercase).
 *   4. INSERT participant ON CONFLICT (aggregator_id, participant_id) DO NOTHING.
 *   5. Run Lua script (§7) for atomic SADD + counter INCR + error HSET.
 *   6. If processed_count == total && reader_done → enqueue Finaliser.
 *
 * Outcome categories:
 *   passed   = INSERT succeeded
 *   skipped  = duplicate (ON CONFLICT)
 *   failed   = validation | normalisation | system_error
 */

import { eq, sql } from 'drizzle-orm';
import {
  runBulkRowCommit,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
} from '@aggregator-dpg/queue';
import { getDb, schema } from '../db.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueFinalise } from '../services/bulk-queue.js';
import { normalisePhone, normaliseEmail } from '../services/phone.js';
import { logger } from '../logger.js';

type ErrorCategory = 'validation' | 'normalisation' | 'duplicate' | 'system_error';

interface RowOutcome {
  outcome: 'passed' | 'skipped' | 'failed';
  category: ErrorCategory | null;
  reasons: string[];
}

const PROGRESS_FLUSH_EVERY = 500;

export async function processBulkRow(job: BulkRowProcessJob): Promise<RowOutcome> {
  const log = logger.child({
    operation: 'bulkRowProcess',
    upload_id: job.uploadId,
    row_index: job.rowIndex,
  });

  // Read pinned schema_id + version off the upload row.
  const uploadRows = await getDb()
    .select()
    .from(schema.bulkUploads)
    .where(eq(schema.bulkUploads.id, job.uploadId))
    .limit(1);
  const upload = uploadRows[0];
  if (!upload) {
    log.warn({ status: 'skipped', reason: 'upload_missing' });
    return { outcome: 'failed', category: 'system_error', reasons: ['upload_missing'] };
  }
  if (upload.status !== 'row_processing') {
    // Job arrived after the run was killed/finalised. Skip silently.
    log.info({ status: 'skipped', reason: 'wrong_status', current_status: upload.status });
    return { outcome: 'skipped', category: null, reasons: [] };
  }

  // 1. Schema validation.
  const validatorResult = await getSchemaLoader().getValidator({
    id: upload.schemaId,
    version: upload.schemaVersion,
  });
  if (!validatorResult.success) {
    return await commit(
      job,
      upload.aggregatorId,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`schema_load_failed: ${validatorResult.error.code}`],
      },
      log,
    );
  }
  const validate = validatorResult.value;
  if (!validate(job.payload)) {
    const reasons = (validate.errors ?? []).map(
      (e) => `${e.instancePath || e.schemaPath}: ${e.message ?? 'invalid'}`,
    );
    return await commit(
      job,
      upload.aggregatorId,
      {
        outcome: 'failed',
        category: 'validation',
        reasons: reasons.length > 0 ? reasons : ['schema validation failed'],
      },
      log,
    );
  }

  // 2. Normalisation.
  const participantId = String(job.payload['participant_id'] ?? '').trim();
  if (!participantId) {
    return await commit(
      job,
      upload.aggregatorId,
      {
        outcome: 'failed',
        category: 'validation',
        reasons: ['participant_id: required'],
      },
      log,
    );
  }
  const phoneRaw = typeof job.payload['phone'] === 'string' ? (job.payload['phone'] as string) : '';
  let phoneNormalised: string | null = null;
  if (phoneRaw) {
    const phone = normalisePhone(phoneRaw);
    if (!phone.ok) {
      return await commit(
        job,
        upload.aggregatorId,
        {
          outcome: 'failed',
          category: 'normalisation',
          reasons: [`phone: ${phone.error.message}`],
        },
        log,
      );
    }
    phoneNormalised = phone.value;
  }
  const emailNormalised = normaliseEmail(
    typeof job.payload['email'] === 'string' ? (job.payload['email'] as string) : null,
  );

  // 3. Persist.
  let outcome: RowOutcome;
  try {
    const inserted = await getDb()
      .insert(schema.participants)
      .values({
        aggregatorId: upload.aggregatorId,
        type: upload.participantType,
        participantId,
        data: job.payload,
        phone: phoneNormalised,
        email: emailNormalised,
        sourceBulkUploadId: upload.id,
        sourceRowIndex: job.rowIndex,
      })
      .onConflictDoNothing({
        target: [schema.participants.aggregatorId, schema.participants.participantId],
      })
      .returning({ id: schema.participants.id });
    if (inserted.length > 0) {
      outcome = { outcome: 'passed', category: null, reasons: [] };
    } else {
      outcome = {
        outcome: 'skipped',
        category: 'duplicate',
        reasons: [`participant_id '${participantId}' already registered for this aggregator`],
      };
    }
  } catch (err) {
    log.error({ status: 'failure', sub: 'db.insert', error: (err as Error).message });
    outcome = {
      outcome: 'failed',
      category: 'system_error',
      reasons: [`db: ${(err as Error).message}`],
    };
  }

  return await commit(job, upload.aggregatorId, outcome, log);
}

/**
 * Atomically commit the row outcome to Redis (Lua) + flush DB counters
 * periodically + check completion.
 */
async function commit(
  job: BulkRowProcessJob,
  _aggregatorId: string,
  outcome: RowOutcome,
  log: typeof logger,
): Promise<RowOutcome> {
  const errorPayload =
    outcome.outcome === 'passed'
      ? ''
      : JSON.stringify({
          row_index: job.rowIndex,
          raw_row: job.rawRow,
          reasons: outcome.reasons,
          error_category: outcome.category,
        });

  const result = await runBulkRowCommit(
    getRedis(),
    job.uploadId,
    job.rowIndex,
    outcome.outcome,
    errorPayload,
  );

  if (result.wasNew === 0) {
    // Replay: row already committed earlier. Skip side-effect bookkeeping.
    log.info({ status: 'replay', outcome: outcome.outcome });
    return outcome;
  }

  // Periodic DB counter flush (every PROGRESS_FLUSH_EVERY rows).
  if (result.processed % PROGRESS_FLUSH_EVERY === 0 || result.processed === result.total) {
    await flushCounters(job.uploadId).catch((err) => {
      log.warn({ status: 'warn', sub: 'flush_counters', error: (err as Error).message });
    });
  }

  // Trigger Finaliser when last row is in.
  if (result.total > 0 && result.processed === result.total && result.readerDone === 1) {
    await enqueueFinalise({ uploadId: job.uploadId } satisfies BulkFinaliseJob);
  }

  log.info({
    status: 'success',
    outcome: outcome.outcome,
    category: outcome.category,
    processed: result.processed,
    total: result.total,
    reader_done: result.readerDone,
  });
  return outcome;
}

/**
 * Flush Redis counters (passed/failed/skipped) into bulk_uploads. Powers
 * DB-only API status reads. Idempotent — overwrites with the latest counts.
 */
async function flushCounters(uploadId: string): Promise<void> {
  const redis = getRedis();
  const ns = `bu:${uploadId}`;
  const [passed, failed, skipped] = await Promise.all([
    redis.hget(`${ns}:counters`, 'passed').then((v) => parseInt(v ?? '0', 10) || 0),
    redis.hget(`${ns}:counters`, 'failed').then((v) => parseInt(v ?? '0', 10) || 0),
    redis.hget(`${ns}:counters`, 'skipped').then((v) => parseInt(v ?? '0', 10) || 0),
  ]);
  await getDb()
    .update(schema.bulkUploads)
    .set({
      passed,
      failed,
      skipped,
      lastProgressAt: new Date(),
      updatedAt: sql`NOW()`,
    })
    .where(eq(schema.bulkUploads.id, uploadId));
}
