/**
 * Bulk uploads endpoints.
 *
 *   POST /v1/bulk-uploads
 *     Reserve a bulk_upload row (status='pending') and return a pre-signed
 *     S3 PUT URL with Content-Type + size constraints baked into the
 *     signature. The browser uploads CSV bytes directly to S3.
 *
 *   POST /v1/bulk-uploads/:id/start
 *     Browser calls this AFTER the S3 PUT completes. The API HEADs the
 *     object to confirm + capture the ETag, transitions status='uploaded',
 *     and (later slices) enqueues the File Processor job.
 *
 *   GET /v1/bulk-uploads/:id
 *     DB-only status read for UI polling. Returns status, counters,
 *     errors_csv_s3_key (when ready). Never reads Redis.
 *
 * All endpoints validate JWT `aggregator_id` matches the resource. Cross-
 * aggregator access returns 403 (not 404 — no enumeration leak).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import { enqueueBulkFileProcess } from '../services/bulk-queue/index.js';
import {
  headObject,
  signBulkUploadUrl,
  signErrorsCsvDownloadUrl,
} from '../services/object-storage/index.js';
import { httpError } from '../errors/http-error.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { buildCsvTemplate } from '../services/csv-template/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { getRedis } from '../services/redis/index.js';

interface CreateBody {
  participant_type?: unknown;
}

/**
 * Loads the network config and returns the set of valid participant
 * types for the active network (e.g. ['seeker','provider'] for blue/purple,
 * ['tourist','practitioner'] for orange_dot).
 */
async function getValidParticipantTypes(): Promise<Set<string>> {
  const cfg = await getNetworkConfig();
  return new Set(cfg.domainIds);
}

export async function registerBulkUploadsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/bulk-uploads/template', async (req, reply) => {
    const auth = await requireAuth(req);
    const query = req.query as { participant_type?: string };
    const participantType = query.participant_type;
    const validTypes = await getValidParticipantTypes();
    if (!participantType || !validTypes.has(participantType)) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
        fields: { participant_type: 'invalid' },
      });
    }
    enforceAggregatorType(auth, participantType as string);

    const schemaResult = await getSchemaLoader().getSchema({
      id: `participant-${participantType}`,
      version: 'v1',
    });
    if (!schemaResult.success) {
      throw httpError('INTERNAL', {
        detail: 'Participant schema unavailable.',
        cause: new Error(schemaResult.error.message),
      });
    }
    const csv = buildCsvTemplate(schemaResult.value);
    void auth; // authenticated for audit; csv content is schema-derived only
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${participantType}-template.csv"`)
      .send(csv);
  });

  app.post('/v1/bulk-uploads', async (req, reply) => {
    const auth = await requireAuth(req);
    const log = req.log.child({ operation: 'bulkUploads.create', actor: auth.userId });
    const start = Date.now();

    const body = (req.body ?? {}) as CreateBody;
    const participantType = typeof body.participant_type === 'string' ? body.participant_type : '';
    const validTypes = await getValidParticipantTypes();
    if (!validTypes.has(participantType)) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
        fields: { participant_type: 'invalid' },
      });
    }
    enforceAggregatorType(auth, participantType as string);

    // Pin the active schema version at create time. v1 is the only published
    // version today; this becomes a registry lookup once schema versioning ships.
    const schemaId = `participant-${participantType}`;
    const schemaVersion = 'v1';

    const store = getBulkUploadsStore();
    const created = await store.create({
      aggregatorId: auth.aggregatorId,
      participantType: participantType as string,
      // Temporary placeholder; replaced after sign call below. We need the
      // row id to compute the deterministic key, so create-then-update.
      s3Key: 'pending',
      schemaId,
      schemaVersion,
      uploadedBy: auth.userId,
    });
    if (!created.ok) {
      log.error({
        status: 'failure',
        error: created.error.code,
        latency_ms: Date.now() - start,
      });
      throw httpError('DB_UNAVAILABLE', { cause: new Error(created.error.message) });
    }

    const uploadId = created.value.id;
    const signed = await signBulkUploadUrl({
      uploadId,
      aggregatorId: auth.aggregatorId,
    });

    // Persist the real key now that we know it. The store doesn't yet expose
    // an updateKey method; reach in via Drizzle directly. (Slice 8 cleanup
    // can move this into the store interface.)
    const { getDb } = await import('../db/client.js');
    const { bulkUploads } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await getDb()
      .update(bulkUploads)
      .set({ s3Key: signed.key, updatedAt: new Date() })
      .where(eq(bulkUploads.id, uploadId));

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      upload_id: uploadId,
      aggregator_id: auth.aggregatorId,
    });

    return reply.code(201).send({
      upload_id: uploadId,
      upload_url: signed.url,
      s3_key: signed.key,
      expires_at: signed.expiresAt,
      content_type: signed.contentType,
      max_bytes: signed.maxBytes,
      schema_id: schemaId,
      schema_version: schemaVersion,
      status: 'pending',
    });
  });

  app.post('/v1/bulk-uploads/:id/start', async (req, reply) => {
    const auth = await requireAuth(req);
    const params = req.params as { id?: string };
    const uploadId = params.id;
    if (!uploadId) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'upload_id is required.' });
    }
    const log = req.log.child({
      operation: 'bulkUploads.start',
      actor: auth.userId,
      upload_id: uploadId,
    });
    const start = Date.now();

    const store = getBulkUploadsStore();
    const found = await store.findById(uploadId, auth.aggregatorId);
    if (!found.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
    }
    if (!found.value) {
      // 403 to prevent cross-aggregator enumeration.
      throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
    }

    const upload = found.value;
    // Idempotent re-call: already past 'uploaded' → just return current.
    if (upload.status !== 'pending' && upload.status !== 'uploaded') {
      log.warn({
        status: 'skipped',
        reason: 'invalid_transition',
        current_status: upload.status,
        latency_ms: Date.now() - start,
      });
      return reply.send(toResponse(upload));
    }

    const head = await headObject(upload.s3Key);
    if (!head) {
      log.warn({
        status: 'failure',
        reason: 's3_object_missing',
        s3_key: upload.s3Key,
        latency_ms: Date.now() - start,
      });
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'CSV upload not found in object storage. Complete the PUT and retry.',
      });
    }
    if (head.contentLength === 0) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'Uploaded CSV is empty.' });
    }
    if (head.contentLength > config.BULK_UPLOAD_MAX_BYTES) {
      // Belt + braces alongside the signed PUT — S3 PUT signing alone does not
      // bind a max size on the GetObject side, and the worker downloads the
      // whole object into memory. Reject before enqueueing.
      log.warn({
        status: 'failure',
        reason: 'object_too_large',
        s3_key: upload.s3Key,
        content_length: head.contentLength,
        max_bytes: config.BULK_UPLOAD_MAX_BYTES,
      });
      throw httpError('SCHEMA_VALIDATION', {
        detail: `Uploaded CSV is too large (${head.contentLength} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}).`,
      });
    }

    // Aggregators are allowed to re-upload the same CSV bytes — the
    // partial UNIQUE on (aggregator_id, s3_etag) was dropped in
    // migration 0011. Any non-OK result here is a real DB / state
    // error, not a duplicate.
    const marked = await store.markUploaded(uploadId, auth.aggregatorId, head.etag);
    if (!marked.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: new Error(marked.error.message) });
    }

    try {
      await enqueueBulkFileProcess({
        uploadId: marked.value.id,
        aggregatorId: auth.aggregatorId,
        s3Key: marked.value.s3Key,
        participantType: marked.value.participantType,
        schemaId: marked.value.schemaId,
        schemaVersion: marked.value.schemaVersion,
      });
    } catch (err) {
      // Enqueue failed but the row is already in 'uploaded' status. The
      // stuck-job watchdog will surface this if no worker picks it up.
      log.error({
        status: 'failure',
        sub_operation: 'enqueue.bulk-file-process',
        error: (err as Error).message,
      });
      throw httpError('INTERNAL', { cause: err });
    }

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      etag: head.etag,
      content_length: head.contentLength,
      next_status: marked.value.status,
    });

    return reply.send(toResponse(marked.value));
  });

  app.get('/v1/bulk-uploads', async (req, reply) => {
    const auth = await requireAuth(req);
    const query = req.query as { limit?: string; offset?: string };
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? '20', 10) || 20));
    const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);

    const store = getBulkUploadsStore();
    const result = await store.list(auth.aggregatorId, { limit, offset });
    if (!result.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
    }
    const countsBatch = await loadCountsBatch(result.value.rows);
    return reply.send({
      items: result.value.rows.map((row) =>
        toResponse(row, countsBatch.get(row.id) ?? ZERO_COUNTS),
      ),
      total: result.value.total,
      limit,
      offset,
    });
  });

  app.get('/v1/bulk-uploads/:id', async (req, reply) => {
    const auth = await requireAuth(req);
    const params = req.params as { id?: string };
    const uploadId = params.id;
    if (!uploadId) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'upload_id is required.' });
    }

    const store = getBulkUploadsStore();
    const found = await store.findById(uploadId, auth.aggregatorId);
    if (!found.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
    }
    if (!found.value) {
      throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
    }

    const counts = await loadCounts(found.value.id, found.value.status);
    return reply.send(toResponse(found.value, counts));
  });

  app.get('/v1/bulk-uploads/:id/errors.csv', async (req, reply) => {
    const auth = await requireAuth(req);
    const params = req.params as { id?: string };
    const uploadId = params.id;
    if (!uploadId) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'upload_id is required.' });
    }
    const log = req.log.child({
      operation: 'bulkUploads.errorsCsv',
      actor: auth.userId,
      upload_id: uploadId,
    });
    const start = Date.now();

    const store = getBulkUploadsStore();
    const found = await store.findById(uploadId, auth.aggregatorId);
    if (!found.ok) {
      throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
    }
    if (!found.value) {
      // 403 to prevent cross-aggregator enumeration.
      throw httpError('FORBIDDEN', { detail: 'Upload not accessible.' });
    }
    const upload = found.value;

    if (upload.status !== 'completed') {
      log.info({
        status: 'skipped',
        reason: 'not_completed',
        current_status: upload.status,
        latency_ms: Date.now() - start,
      });
      throw httpError('BULK_UPLOAD_NOT_READY', {
        detail: `Upload is in status '${upload.status}'. The errors report is generated only after finalisation.`,
      });
    }
    if (!upload.errorsCsvS3Key) {
      // The Finaliser only writes errors.csv when `failed > 0`. A null key
      // on a completed run = clean upload (every row passed). Communicate
      // that to the UI so it can hide the "Download errors" button instead
      // of rendering it as a broken link.
      log.info({
        status: 'skipped',
        reason: 'no_errors_to_report',
      });
      throw httpError('NOT_FOUND', {
        detail: 'No errors to download — all rows in this upload passed.',
      });
    }
    // Hardened: only sign keys that match the canonical errors.csv layout.
    // Even though the worker writes a deterministic key, this guards against
    // any future path (or DB tamper) signing a GET URL for an arbitrary object.
    const expectedKey = `bulk-uploads/${upload.id}/errors.csv`;
    if (upload.errorsCsvS3Key !== expectedKey) {
      log.error({
        status: 'failure',
        reason: 'errors_csv_key_invalid',
        s3_key: upload.errorsCsvS3Key,
      });
      throw httpError('NOT_FOUND', { detail: 'Errors report not available for this upload.' });
    }

    const signed = await signErrorsCsvDownloadUrl(upload.errorsCsvS3Key);

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      s3_key: upload.errorsCsvS3Key,
    });

    const counts = await loadCounts(upload.id, upload.status);
    return reply.send({
      upload_id: upload.id,
      url: signed.url,
      s3_key: signed.key,
      expires_at: signed.expiresAt,
      content_type: 'text/csv',
      counts: {
        total_rows: counts.totalRows,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
      },
    });
  });
}

interface BulkUploadResponseShape {
  upload_id: string;
  status: string;
  status_reason: string | null;
  participant_type: string;
  total_rows: number | null;
  passed: number;
  failed: number;
  skipped: number;
  errors_csv_s3_key: string | null;
  schema_id: string;
  schema_version: string;
  created_at: string;
  completed_at: string | null;
}

interface UploadCounts {
  totalRows: number | null;
  passed: number;
  failed: number;
  skipped: number;
}

const ZERO_COUNTS: UploadCounts = { totalRows: null, passed: 0, failed: 0, skipped: 0 };

interface UploadShape {
  id: string;
  status: string;
  statusReason: string | null;
  participantType: string;
  errorsCsvS3Key: string | null;
  schemaId: string;
  schemaVersion: string;
  createdAt: Date;
  completedAt: Date | null;
}

function toResponse(
  upload: UploadShape,
  counts: UploadCounts = ZERO_COUNTS,
): BulkUploadResponseShape {
  return {
    upload_id: upload.id,
    status: upload.status,
    status_reason: upload.statusReason,
    participant_type: upload.participantType,
    total_rows: counts.totalRows,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    errors_csv_s3_key: upload.errorsCsvS3Key,
    schema_id: upload.schemaId,
    schema_version: upload.schemaVersion,
    created_at: upload.createdAt.toISOString(),
    completed_at: upload.completedAt ? upload.completedAt.toISOString() : null,
  };
}

/**
 * Loads live counters from Redis for an in-flight upload. Returns ZERO_COUNTS
 * when keys are missing (run not started, or already finalised + GC'd).
 */
async function loadCountsFromRedis(uploadId: string): Promise<UploadCounts> {
  try {
    const redis = getRedis();
    const ns = `bu:${uploadId}`;
    const [counters, meta] = await Promise.all([
      redis.hmget(`${ns}:counters`, 'passed', 'failed', 'skipped'),
      redis.hget(`${ns}:meta`, 'total_rows'),
    ]);
    const passed = parseInt(counters[0] ?? '0', 10) || 0;
    const failed = parseInt(counters[1] ?? '0', 10) || 0;
    const skipped = parseInt(counters[2] ?? '0', 10) || 0;
    const totalRows = meta ? parseInt(meta, 10) || null : null;
    return { totalRows, passed, failed, skipped };
  } catch {
    return ZERO_COUNTS;
  }
}

/**
 * Loads terminal counters from the `onboarding` row written by `bulk-finalise`.
 * Returns ZERO_COUNTS if the row is missing (would indicate a stale completed
 * upload that pre-dates the rollup migration).
 */
async function loadCountsFromOnboarding(uploadId: string): Promise<UploadCounts> {
  const rows = await getDb()
    .select({
      total: onboarding.total,
      passed: onboarding.passed,
      failed: onboarding.failed,
      skipped: onboarding.skipped,
    })
    .from(onboarding)
    .where(and(eq(onboarding.source, 'bulk'), eq(onboarding.batchId, uploadId)))
    .limit(1);
  const row = rows[0];
  if (!row) return ZERO_COUNTS;
  return {
    totalRows: row.total,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
  };
}

/** Picks the right counter source based on upload status. */
async function loadCounts(uploadId: string, status: string): Promise<UploadCounts> {
  if (status === 'completed') return loadCountsFromOnboarding(uploadId);
  if (status === 'pending' || status === 'uploaded') return ZERO_COUNTS;
  return loadCountsFromRedis(uploadId);
}

/** Batch counter load for list view — one onboarding query, Redis fan-out for active rows. */
async function loadCountsBatch(
  uploads: Array<{ id: string; status: string }>,
): Promise<Map<string, UploadCounts>> {
  const out = new Map<string, UploadCounts>();
  const completedIds = uploads.filter((u) => u.status === 'completed').map((u) => u.id);
  if (completedIds.length > 0) {
    const rows = await getDb()
      .select({
        batchId: onboarding.batchId,
        total: onboarding.total,
        passed: onboarding.passed,
        failed: onboarding.failed,
        skipped: onboarding.skipped,
      })
      .from(onboarding)
      .where(and(eq(onboarding.source, 'bulk'), inArray(onboarding.batchId, completedIds)));
    for (const r of rows) {
      if (!r.batchId) continue;
      out.set(r.batchId, {
        totalRows: r.total,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
      });
    }
  }
  const liveUploads = uploads.filter(
    (u) => u.status !== 'completed' && u.status !== 'pending' && u.status !== 'uploaded',
  );
  for (const u of liveUploads) {
    out.set(u.id, await loadCountsFromRedis(u.id));
  }
  return out;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}

/**
 * Reject when the requested participant type does not match the aggregator's
 * registered type (read from the JWT `aggregator_type` claim). An aggregator
 * may only upload or template the type it registered as.
 */
function enforceAggregatorType(auth: AuthContext, participantType: string): void {
  if (!auth.aggregatorType) {
    throw httpError('AGGREGATOR_TYPE_MISSING', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  if (auth.aggregatorType !== participantType) {
    throw httpError('AGGREGATOR_TYPE_MISMATCH', {
      fields: {
        aggregator_type: auth.aggregatorType,
        requested_type: participantType,
      },
    });
  }
}
