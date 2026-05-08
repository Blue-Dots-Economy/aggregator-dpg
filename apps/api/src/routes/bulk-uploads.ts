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
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import { enqueueBulkFileProcess } from '../services/bulk-queue/index.js';
import {
  headObject,
  signBulkUploadUrl,
  signErrorsCsvDownloadUrl,
} from '../services/object-storage/index.js';
import { httpError } from '../errors/http-error.js';

interface CreateBody {
  participant_type?: unknown;
}

const VALID_TYPES = new Set(['seeker', 'provider']);

export async function registerBulkUploadsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/bulk-uploads', async (req, reply) => {
    const auth = await requireAuth(req);
    const log = req.log.child({ operation: 'bulkUploads.create', actor: auth.userId });
    const start = Date.now();

    const body = (req.body ?? {}) as CreateBody;
    const participantType = typeof body.participant_type === 'string' ? body.participant_type : '';
    if (!VALID_TYPES.has(participantType)) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'participant_type must be "seeker" or "provider".',
        fields: { participant_type: 'invalid' },
      });
    }

    // Pin the active schema version at create time. v1 is the only published
    // version today; this becomes a registry lookup once schema versioning ships.
    const schemaId = `participant-${participantType}`;
    const schemaVersion = 'v1';

    const store = getBulkUploadsStore();
    const created = await store.create({
      aggregatorId: auth.aggregatorId,
      participantType: participantType as 'seeker' | 'provider',
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

    const marked = await store.markUploaded(uploadId, auth.aggregatorId, head.etag);
    if (!marked.ok) {
      if (marked.error.code === 'DUPLICATE_ETAG') {
        // Re-upload of identical CSV under same aggregator. Surface the existing
        // upload row so the client can poll it.
        const existing = await store.findByAggregatorAndEtag(auth.aggregatorId, head.etag);
        if (existing.ok && existing.value) {
          return reply.send(toResponse(existing.value));
        }
      }
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

    return reply.send(toResponse(found.value));
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
      // Defensive: should always be set when status='completed', but
      // surface it cleanly if a future code path leaves it null.
      log.error({ status: 'failure', reason: 'errors_csv_key_missing' });
      throw httpError('NOT_FOUND', { detail: 'Errors report not available for this upload.' });
    }

    const signed = await signErrorsCsvDownloadUrl(upload.errorsCsvS3Key);

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      s3_key: upload.errorsCsvS3Key,
    });

    return reply.send({
      upload_id: upload.id,
      url: signed.url,
      s3_key: signed.key,
      expires_at: signed.expiresAt,
      content_type: 'text/csv',
      counts: {
        total_rows: upload.totalRows,
        passed: upload.passed,
        failed: upload.failed,
        skipped: upload.skipped,
      },
    });
  });
}

interface BulkUploadResponseShape {
  upload_id: string;
  status: string;
  status_reason: string | null;
  participant_type: 'seeker' | 'provider';
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

function toResponse(upload: {
  id: string;
  status: string;
  statusReason: string | null;
  participantType: 'seeker' | 'provider';
  totalRows: number | null;
  passed: number;
  failed: number;
  skipped: number;
  errorsCsvS3Key: string | null;
  schemaId: string;
  schemaVersion: string;
  createdAt: Date;
  completedAt: Date | null;
}): BulkUploadResponseShape {
  return {
    upload_id: upload.id,
    status: upload.status,
    status_reason: upload.statusReason,
    participant_type: upload.participantType,
    total_rows: upload.totalRows,
    passed: upload.passed,
    failed: upload.failed,
    skipped: upload.skipped,
    errors_csv_s3_key: upload.errorsCsvS3Key,
    schema_id: upload.schemaId,
    schema_version: upload.schemaVersion,
    created_at: upload.createdAt.toISOString(),
    completed_at: upload.completedAt ? upload.completedAt.toISOString() : null,
  };
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (!result.ok) {
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}
