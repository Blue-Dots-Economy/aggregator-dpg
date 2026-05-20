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

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  runBulkRowCommit,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
} from '@aggregator-dpg/queue';
import { PostgresParticipantsWriter } from '@aggregator-dpg/participants-writer/postgres';
import type { ParticipantsWriterBase } from '@aggregator-dpg/participants-writer/interface';
import { getDb, schema } from '../db.js';
import { getSchemaLoader } from '../services/schema-loader.js';
import { getRedis } from '../services/redis.js';
import { enqueueFinalise } from '../services/bulk-queue.js';
import { normalisePhone, normaliseEmail } from '../services/phone.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

let participantsWriter: ParticipantsWriterBase | null = null;
function getParticipantsWriter(): ParticipantsWriterBase {
  if (participantsWriter) return participantsWriter;
  participantsWriter = new PostgresParticipantsWriter(getDb());
  return participantsWriter;
}

/** Test helper — override the writer (e.g., inject a fake). */
export function _setParticipantsWriter(w: ParticipantsWriterBase | null): void {
  participantsWriter = w;
}

const VALID_PARTICIPANT_TYPES = new Set(['seeker', 'provider']);

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

  // Job payload carries the schema ref + participant type pinned by the File
  // Processor — no per-row SELECT on bulk_uploads needed. Status guards live
  // in the Finaliser and the File Processor entry guard; stale row jobs are a
  // non-issue here because the Lua commit script + jobId dedup absorb replays.
  if (!VALID_PARTICIPANT_TYPES.has(job.participantType)) {
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`invalid participant_type: ${job.participantType}`],
      },
      log,
    );
  }

  // 1. Schema validation. Load schema + validator together (both cached
  // by the loader) so we can pre-split comma-joined array cells before Ajv
  // runs. Ajv's `coerceTypes: 'array'` wraps a single string into a
  // one-element array but does NOT split on `,` — that's our job.
  const ref = { id: job.schemaId, version: job.schemaVersion };
  const loader = getSchemaLoader();
  const [validatorResult, schemaResult] = await Promise.all([
    loader.getValidator(ref),
    loader.getSchema(ref),
  ]);
  if (!validatorResult.success) {
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'system_error',
        reasons: [`schema_load_failed: ${validatorResult.error.code}`],
      },
      log,
    );
  }
  if (schemaResult.success) {
    preprocessArrayCells(job.payload, schemaResult.value);
  }
  const validate = validatorResult.value;
  if (!validate(job.payload)) {
    const reasons = (validate.errors ?? []).map(
      (e) => `${e.instancePath || e.schemaPath}: ${e.message ?? 'invalid'}`,
    );
    return await commit(
      job,
      {
        outcome: 'failed',
        category: 'validation',
        reasons: reasons.length > 0 ? reasons : ['schema validation failed'],
      },
      log,
    );
  }

  // 2. Normalisation. Auto-allocate a UUID when the row carries no explicit
  // `participant_id` — keeps the `(aggregator, type, participant_id)` unique
  // index satisfied while letting the participant schema decide whether the
  // field is a meaningful business id or not.
  const rawParticipantId = String(job.payload['participant_id'] ?? '').trim();
  const participantId = rawParticipantId.length > 0 ? rawParticipantId : randomUUID();
  const phoneRaw = typeof job.payload['phone'] === 'string' ? (job.payload['phone'] as string) : '';
  let phoneNormalised: string | null = null;
  if (phoneRaw) {
    const phone = normalisePhone(phoneRaw);
    if (!phone.ok) {
      return await commit(
        job,
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

  // 3. Persist via the participants-writer wrapper (shared by bulk + link).
  let outcome: RowOutcome;
  const writeResult = await getParticipantsWriter().writeBulkRow({
    aggregatorId: job.aggregatorId,
    type: job.participantType,
    participantId,
    data: job.payload,
    phone: phoneNormalised,
    email: emailNormalised,
    sourceBulkUploadId: job.uploadId,
    sourceRowIndex: job.rowIndex,
  });
  if (writeResult.success) {
    if (writeResult.value.outcome === 'passed') {
      outcome = { outcome: 'passed', category: null, reasons: [] };
      await pushToSignalStack(job, participantId, phoneNormalised, emailNormalised, log);
    } else {
      outcome = {
        outcome: 'skipped',
        category: 'duplicate',
        reasons: [`participant_id '${participantId}' already registered for this aggregator`],
      };
    }
  } else {
    log.error({
      status: 'failure',
      sub: 'participants.write',
      error: writeResult.error.message,
    });
    outcome = {
      outcome: 'failed',
      category: 'system_error',
      reasons: [`db: ${writeResult.error.message}`],
    };
  }

  return await commit(job, outcome, log);
}

/**
 * Atomically commit the row outcome to Redis (Lua) + flush DB counters
 * periodically + check completion.
 */
async function commit(
  job: BulkRowProcessJob,
  outcome: RowOutcome,
  log: typeof logger,
): Promise<RowOutcome> {
  // Only `failed` outcomes get a payload — `skipped` (e.g. duplicate
  // participant) is dedup, not an error, and must not appear in errors.csv.
  // raw_row is reconstructed by the Finaliser from `bu:{id}:lines` keyed on
  // row_index, so it does NOT travel in the per-row job payload anymore.
  const errorPayload =
    outcome.outcome === 'failed'
      ? JSON.stringify({
          row_index: job.rowIndex,
          reasons: outcome.reasons,
          error_category: outcome.category,
        })
      : '';

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

  // Heartbeat: bump last_progress_at every PROGRESS_FLUSH_EVERY rows so the
  // watchdog can detect stalled jobs. Counters live in Redis only — the
  // bulk_uploads counter columns were dropped in migration 0009.
  if (result.processed % PROGRESS_FLUSH_EVERY === 0 || result.processed === result.total) {
    await bumpHeartbeat(job.uploadId).catch((err) => {
      log.warn({ status: 'warn', sub: 'heartbeat', error: (err as Error).message });
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
 * Best-effort outward push of the freshly-inserted participant to signalstack.
 *
 * Sync-awaited (one HTTP call per row) so we can log a deterministic outcome
 * per row, but failures NEVER alter the local participant write result —
 * signalstack is treated as a downstream sink, not a transactional partner.
 * Returns void; status is observable via structured logs.
 */
async function pushToSignalStack(
  job: BulkRowProcessJob,
  participantId: string,
  phone: string | null,
  email: string | null,
  log: typeof logger,
): Promise<void> {
  const ss = getSignalStackWriter();
  if (!ss) return;
  const name =
    typeof job.payload['name'] === 'string' ? (job.payload['name'] as string) : participantId;
  const result = await ss.onboard({
    user: { name, phoneNumber: phone, email },
    profile: {
      item_network: config.SIGNALSTACK_ITEM_NETWORK,
      item_domain: job.participantType,
      item_type: job.participantType === 'provider' ? 'job_posting_1.0' : 'profile_1.0',
      item_state: job.payload,
    },
    aggregator_id: job.aggregatorId,
  });
  if (!result.success) {
    log.warn({
      status: 'warn',
      sub: 'signalstack.push',
      error: result.error.message,
      code: result.error.code,
    });
    return;
  }
  log.info({
    status: 'success',
    sub: 'signalstack.push',
    user_id: result.value.user.id,
    profile_count: result.value.profiles.length,
  });
}

/**
 * Mutates `payload` in place: for every schema property declared with
 * `type: 'array'`, if the cell arrived as a string (CSV form), split it on
 * commas into a trimmed array. Empty cells become empty arrays. Non-string
 * values are left untouched. Worker complement to Ajv `coerceTypes: 'array'`
 * which wraps a string into a one-element array but never splits on commas.
 */
function preprocessArrayCells(
  payload: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): void {
  const props = jsonSchema['properties'];
  if (!props || typeof props !== 'object') return;
  for (const [field, def] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    if (def?.['type'] !== 'array') continue;
    const cell = payload[field];
    if (typeof cell !== 'string') continue;
    payload[field] = cell
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}

/**
 * Heartbeat-only DB write — bumps `last_progress_at` so the watchdog can
 * detect stalled jobs. Counters live exclusively in Redis (live) and the
 * `onboarding` row (after `bulk-finalise`).
 */
async function bumpHeartbeat(uploadId: string): Promise<void> {
  await getDb()
    .update(schema.bulkUploads)
    .set({
      lastProgressAt: new Date(),
      updatedAt: sql`NOW()`,
    })
    .where(eq(schema.bulkUploads.id, uploadId));
}
