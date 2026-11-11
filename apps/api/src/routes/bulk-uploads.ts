/**
 * Bulk uploads endpoints.
 *
 *   POST /v1/bulk-uploads
 *     Reserves a `pending` upload row and returns pre-signed upload
 *     instructions. The browser uploads the CSV directly to object storage.
 *
 *   POST /v1/bulk-uploads/:id/start
 *     Called after the upload. Checks the object exists, marks the row
 *     `uploaded` and enqueues the file-processing job.
 *
 *   GET /v1/bulk-uploads/:id
 *     Status read for UI polling: status, counters and the errors.csv key.
 *
 * Every endpoint checks the token's `aggregator_id` owns the upload; another
 * aggregator's upload answers 403. Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getBulkUploadsStore } from '../services/bulk-uploads-store/index.js';
import { enqueueBulkFileProcess } from '../services/bulk-queue/index.js';
import {
  fromStoredKey,
  getObjectStorage,
  toStoredKey,
  type ObjectRef,
} from '@aggregator-dpg/object-storage';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { checkBulkTemplateRate, checkBulkUploadRate } from '../services/bulk-upload-rate.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { buildCsvTemplate } from '../services/csv-template/index.js';
import { buildXlsxTemplate } from '../services/xlsx-template/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { getRedis } from '../services/redis/index.js';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';
import { errorMessage } from '@aggregator-dpg/shared-primitives/errors';
import { requireServedDomain } from './served-domains-shared.js';

/**
 * Returns the valid participant types for the active network.
 */
async function getValidParticipantTypes(): Promise<Set<string>> {
  const cfg = await getNetworkConfig();
  return new Set(cfg.domainIds);
}

/**
 * Loads the participant schema behind a template request.
 *
 * A missing schema is INTERNAL, not 404, because the type was already validated.
 *
 * @param participantType - Already-validated participant domain id.
 * @returns The participant JSON Schema.
 * @throws {HttpError} INTERNAL when the schema cannot be loaded.
 */
async function loadParticipantSchema(participantType: string): Promise<JsonSchema> {
  const result = await getSchemaLoader().getSchema({
    id: `participant-${participantType}`,
    version: 'v1',
  });
  if (!result.success) {
    throw httpError('INTERNAL', {
      detail: 'Participant schema unavailable.',
      cause: new Error(result.error.message),
    });
  }
  return result.value;
}

/**
 * Query shape for the template download.
 *
 * `participant_type` is a string; the handler checks it against the network config.
 */
const TemplateQuerySchema = z.object({
  participant_type: z
    .string()
    .optional()
    .describe('Participant domain id declared by the active network (e.g. seeker, provider).'),
  /**
   * `csv` (default) returns the header and one example row. `xlsx` returns a
   * four-tab workbook with dropdowns, required markers and sample rows.
   * Uploads accept `.csv` only.
   */
  format: z.enum(['csv', 'xlsx']).optional().describe('Template format. Defaults to csv.'),
});

/**
 * Body for creating a bulk-upload job.
 *
 * `participant_type` is checked against the active network config.
 */
const CreateBulkUploadBodySchema = z
  .object({
    participant_type: z
      .string()
      .min(1)
      .describe('Participant domain id declared by the active network (e.g. seeker, provider).'),
  })
  .passthrough();

/** Path params for routes addressing a single bulk-upload job. */
const BulkUploadParamsSchema = z.object({
  id: z.string().min(1).describe('Bulk-upload job id (UUID).'),
});

/**
 * Body for `/start`.
 *
 * `attestation` must be `true`, else the upload is rejected with 400 CONSENT_REQUIRED.
 */
const StartBulkUploadBodySchema = z
  .object({
    attestation: z.boolean().optional().describe('Operator attestation of authority to upload.'),
  })
  .passthrough();

/**
 * Pagination query for the bulk-uploads list.
 *
 * `limit` is 1-100 (default 20) and `offset` is ≥ 0 (default 0). Out-of-range
 * values answer 400 SCHEMA_VALIDATION.
 */
const ListBulkUploadsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Page size (1-100, default 20).'),
  offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip (≥ 0, default 0).'),
});

/** Wire shape of a bulk-upload job row (see {@link toResponse}). */
const BulkUploadResponseSchema = z
  .object({
    upload_id: z.string(),
    status: z.string(),
    status_reason: z.string().nullable(),
    participant_type: z.string(),
    total_rows: z.number().nullable(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    errors_csv_s3_key: z.string().nullable(),
    schema_id: z.string(),
    schema_version: z.string(),
    created_at: z.string(),
    completed_at: z.string().nullable(),
  })
  .passthrough();

/** 201 payload for POST /v1/bulk-uploads — pre-signed upload reservation. */
const CreateBulkUploadResponseSchema = z
  .object({
    upload_id: z.string(),
    upload: z.object({
      method: z.enum(['PUT', 'POST']),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      form_fields: z.record(z.string(), z.string()),
    }),
    upload_url: z.string().describe('Deprecated: use upload.url.'),
    s3_key: z.string(),
    expires_at: z.string(),
    content_type: z.string().describe('Deprecated: use upload.headers["Content-Type"].'),
    max_bytes: z.number(),
    schema_id: z.string(),
    schema_version: z.string(),
    status: z.string(),
  })
  .passthrough();

/** 200 payload for the paginated bulk-uploads list. */
const ListBulkUploadsResponseSchema = z
  .object({
    items: z.array(BulkUploadResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .passthrough();

/** 200 payload for the errors.csv signed-download endpoint. */
const ErrorsCsvResponseSchema = z
  .object({
    upload_id: z.string(),
    url: z.string(),
    s3_key: z.string(),
    expires_at: z.string(),
    content_type: z.string(),
    counts: z
      .object({
        total_rows: z.number().nullable(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

export async function registerBulkUploadsRoutes(base: FastifyInstance): Promise<void> {
  const app = base.withTypeProvider<ZodTypeProvider>();
  // The 200 reply is a file, so it has no response schema; `Reply` types it instead.
  app.get<{ Querystring: z.output<typeof TemplateQuerySchema>; Reply: string | Buffer }>(
    '/v1/bulk-uploads/template',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Download the bulk-upload template (CSV or XLSX)',
        description:
          "Both formats are generated from the participant schema resolved out of network.json for ?participant_type= (seeker/provider), and both are gated on the caller's registered aggregator_type. ?format=csv (default) returns text/csv: the header row plus one example row. ?format=xlsx returns a four-tab workbook for that type — instructions, allowed values, worked sample rows and an empty grid with dropdowns on every closed-set column. Array-typed fields use the network's csv_array_delimiter. Responds with a file attachment on 200 (no JSON body).",
        security: [{ bearerAuth: [] }],
        querystring: TemplateQuerySchema,
        response: {
          ...errorResponses(400, 401, 403, 429, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);

      // Per-coordinator rate limit. Fails open on a Redis error.
      const templateRate = await checkBulkTemplateRate(auth.userId);
      if (!templateRate.allowed) {
        throw httpError('RATE_LIMITED', {
          detail: 'Too many template requests; please try again later.',
          fields: { retryAfterSeconds: templateRate.retryAfterSeconds },
        });
      }

      const format = req.query.format ?? 'csv';
      const validTypes = await getValidParticipantTypes();

      const query = req.query;
      const participantType = query.participant_type;
      if (!participantType || !validTypes.has(participantType)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
          fields: { participant_type: 'invalid' },
        });
      }
      await requireServedDomain(auth, participantType);

      // Both formats are generated from the live participant schema, one
      // participant type per file.
      if (format === 'xlsx') {
        const cfgForXlsx = await getNetworkConfig();
        const workbook = await buildXlsxTemplate(
          await loadParticipantSchema(participantType),
          participantType,
          {
            arrayDelimiter: cfgForXlsx.aggregator.network.csv_array_delimiter,
            // Names the phone and email columns so their samples are realistic.
            identity: cfgForXlsx.domains[participantType]?.identity,
          },
        );
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .header('Content-Disposition', `attachment; filename="${participantType}-template.xlsx"`)
          .send(workbook);
      }

      const csvSchema = await loadParticipantSchema(participantType);
      const cfg = await getNetworkConfig();
      const csv = buildCsvTemplate(csvSchema, {
        arrayDelimiter: cfg.aggregator.network.csv_array_delimiter,
        // Without these, the phone sample would fail row validation.
        identity: cfg.domains[participantType]?.identity,
      });
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${participantType}-template.csv"`)
        .send(csv);
    },
  );

  app.post(
    '/v1/bulk-uploads',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Create a new bulk-upload job',
        description:
          'Reserves a pending bulk-upload job for the caller aggregator and returns pre-signed upload instructions. The browser uploads CSV bytes directly to object storage, then calls /start. `participant_type` is validated against the active network config at request time.',
        security: [{ bearerAuth: [] }],
        body: CreateBulkUploadBodySchema,
        response: {
          201: CreateBulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 429, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);

      // Per-coordinator rate limit.
      const uploadRate = await checkBulkUploadRate(auth.userId);
      if (!uploadRate.allowed) {
        throw httpError('RATE_LIMITED', {
          detail: 'Too many bulk uploads; please try again later.',
          fields: { retryAfterSeconds: uploadRate.retryAfterSeconds },
        });
      }

      const log = req.log.child({ operation: 'bulkUploads.create', actor: auth.userId });
      const start = Date.now();

      // Check the type against the network config.
      const { participant_type: participantType } = req.body;
      const validTypes = await getValidParticipantTypes();
      if (!validTypes.has(participantType)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `participant_type must be one of: ${[...validTypes].join(', ')}.`,
          fields: { participant_type: 'invalid' },
        });
      }
      await requireServedDomain(auth, participantType);

      // Record the schema version at create time. Only v1 exists.
      const schemaId = `participant-${participantType}`;
      const schemaVersion = 'v1';

      const store = getBulkUploadsStore();
      const created = await store.create({
        aggregatorId: auth.aggregatorId,
        participantType,
        // Placeholder; the real key needs the row id and is set below.
        storageKey: 'pending',
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
      const ref: ObjectRef = {
        area: 'bulk-uploads',
        key: `${auth.aggregatorId}/${uploadId}/raw.csv`,
      };
      const storedKey = toStoredKey(ref);
      const signed = await getObjectStorage().createUpload({
        ref,
        contentType: 'text/csv',
        maxBytes: config.BULK_UPLOAD_MAX_BYTES,
        expiresInSeconds: config.BULK_UPLOAD_URL_TTL_SECONDS,
      });
      if (!signed.success) throw signed.error;
      const instructions = signed.value;

      // Store the real key. The store has no method for this, so use Drizzle directly.
      const { getDb } = await import('../db/client.js');
      const { bulkUploads } = await import('../db/schema.js');
      const { eq } = await import('drizzle-orm');
      await getDb()
        .update(bulkUploads)
        .set({ s3Key: storedKey, updatedAt: new Date() })
        .where(eq(bulkUploads.id, uploadId));

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        upload_id: uploadId,
        aggregator_id: auth.aggregatorId,
      });

      return reply.code(201).send({
        upload_id: uploadId,
        upload: {
          method: instructions.method,
          url: instructions.url,
          headers: instructions.headers,
          form_fields: instructions.formFields,
        },
        upload_url: instructions.url,
        s3_key: storedKey,
        expires_at: instructions.expiresAt,
        content_type: 'text/csv',
        max_bytes: config.BULK_UPLOAD_MAX_BYTES,
        schema_id: schemaId,
        schema_version: schemaVersion,
        status: 'pending',
      });
    },
  );

  app.post(
    '/v1/bulk-uploads/:id/start',
    {
      config: { rbac: { capability: 'profiles.onboard' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Start processing a pending bulk-upload job',
        description:
          'Transitions a pending job to running; the worker onboards each valid row to signalstack. Idempotent on already-running/completed jobs.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        body: StartBulkUploadBodySchema,
        response: {
          200: BulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params;
      const body = req.body;
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
      // Already past 'uploaded': return the current state.
      if (upload.status !== 'pending' && upload.status !== 'uploaded') {
        log.warn({
          status: 'skipped',
          reason: 'invalid_transition',
          current_status: upload.status,
          latency_ms: Date.now() - start,
        });
        return reply.send(toResponse(upload));
      }

      // The aggregator must attest permission to submit these participants.
      // Checked before any storage call or state change.
      if (body.attestation !== true) {
        throw httpError('CONSENT_REQUIRED', {
          detail: 'You must confirm authority to upload before starting.',
          fields: { attestation: body.attestation ?? null },
        });
      }

      const parsedRef = fromStoredKey('bulk-uploads', upload.storageKey);
      const statResult = parsedRef.success ? await getObjectStorage().stat(parsedRef.value) : null;
      if (statResult && !statResult.success) throw statResult.error;
      const head = statResult?.value ?? null;
      if (!head) {
        log.warn({
          status: 'failure',
          reason: 'storage_object_missing',
          storage_key: upload.storageKey,
          latency_ms: Date.now() - start,
        });
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'CSV upload not found in object storage. Complete the PUT and retry.',
        });
      }
      if (head.size === 0) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'Uploaded CSV is empty.' });
      }
      if (head.size > config.BULK_UPLOAD_MAX_BYTES) {
        log.warn({
          status: 'failure',
          reason: 'object_too_large',
          storage_key: upload.storageKey,
          content_length: head.size,
          max_bytes: config.BULK_UPLOAD_MAX_BYTES,
        });
        throw httpError('SCHEMA_VALIDATION', {
          detail: `Uploaded CSV is too large (${head.size} bytes; max ${config.BULK_UPLOAD_MAX_BYTES}).`,
        });
      }

      // Record the attestation before the state change. Fails closed: no upload
      // is processed without one.
      const attestationRecorded = await recordBulkUploadAttestation({
        aggregatorId: auth.aggregatorId,
        uploadId,
        log,
      });
      if (!attestationRecorded) {
        throw httpError('CONSENT_WRITE_FAILED', {
          fields: { sub_operation: 'recordBulkUploadAttestation' },
        });
      }

      // Re-uploading the same file is allowed, so a failure here is never a duplicate.
      const marked = await store.markUploaded(uploadId, auth.aggregatorId, head.fingerprint);
      if (!marked.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(marked.error.message) });
      }

      try {
        await enqueueBulkFileProcess({
          uploadId: marked.value.id,
          aggregatorId: auth.aggregatorId,
          s3Key: marked.value.storageKey,
          participantType: marked.value.participantType,
          schemaId: marked.value.schemaId,
          schemaVersion: marked.value.schemaVersion,
        });
      } catch (err) {
        // The row stays 'uploaded'; the stuck-job watchdog picks it up.
        log.error({
          status: 'failure',
          sub_operation: 'enqueue.bulk-file-process',
          error: errorMessage(err),
        });
        throw httpError('INTERNAL', { cause: err });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        fingerprint: head.fingerprint,
        content_length: head.size,
        next_status: marked.value.status,
      });

      return reply.send(toResponse(marked.value));
    },
  );

  app.get(
    '/v1/bulk-uploads',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'List bulk-upload jobs',
        description: 'Paginated list of bulk-upload jobs (newest first) for the caller aggregator.',
        security: [{ bearerAuth: [] }],
        querystring: ListBulkUploadsQuerySchema,
        response: {
          200: ListBulkUploadsResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const { limit, offset } = req.query;

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
    },
  );

  app.get(
    '/v1/bulk-uploads/:id',
    {
      config: { rbac: { capability: 'profiles.view' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Read a bulk-upload job',
        description:
          'Returns the full job row including status, per-row counters, and error summary.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        response: {
          200: BulkUploadResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params;

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
    },
  );

  app.get(
    '/v1/bulk-uploads/:id/errors.csv',
    {
      // The report holds participant contact data, so it needs the export permission.
      config: { rbac: { capability: 'profiles.view_pii' } },
      schema: {
        tags: ['bulk-uploads'],
        summary: 'Download per-row error CSV',
        description:
          'Returns a JSON payload carrying a short-lived pre-signed download URL for the errors.csv report (rows that failed validation/onboarding with reason + offending fields), plus the final counters. Only available once the upload is completed and at least one row failed.',
        security: [{ bearerAuth: [] }],
        params: BulkUploadParamsSchema,
        response: {
          200: ErrorsCsvResponseSchema,
          ...errorResponses(400, 401, 403, 404, 410, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      // Params are already validated by the route schema (id: non-empty string).
      const { id: uploadId } = req.params;
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
      if (!upload.errorsCsvStorageKey) {
        // No key on a completed run means every row passed; there is no errors.csv.
        log.info({
          status: 'skipped',
          reason: 'no_errors_to_report',
        });
        throw httpError('NOT_FOUND', {
          detail: 'No errors to download — all rows in this upload passed.',
        });
      }
      // Only sign keys that match the errors.csv layout, never an arbitrary object.
      const expectedKey = `bulk-uploads/${upload.id}/errors.csv`;
      if (upload.errorsCsvStorageKey !== expectedKey) {
        log.error({
          status: 'failure',
          reason: 'errors_csv_key_invalid',
          storage_key: upload.errorsCsvStorageKey,
        });
        throw httpError('NOT_FOUND', { detail: 'Errors report not available for this upload.' });
      }

      const errorsRef = fromStoredKey('bulk-uploads', upload.errorsCsvStorageKey);
      if (!errorsRef.success) {
        throw httpError('NOT_FOUND', { detail: 'Errors report not available for this upload.' });
      }
      const signed = await getObjectStorage().createDownloadUrl({
        ref: errorsRef.value,
        expiresInSeconds: config.BULK_UPLOAD_URL_TTL_SECONDS,
        filename: 'errors.csv',
        contentType: 'text/csv',
      });
      if (!signed.success) throw signed.error;

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        storage_key: upload.errorsCsvStorageKey,
      });

      const counts = await loadCounts(upload.id, upload.status);
      return reply.send({
        upload_id: upload.id,
        url: signed.value.url,
        s3_key: upload.errorsCsvStorageKey,
        expires_at: signed.value.expiresAt,
        content_type: 'text/csv',
        counts: {
          total_rows: counts.totalRows,
          passed: counts.passed,
          failed: counts.failed,
          skipped: counts.skipped,
        },
      });
    },
  );
}

type BulkUploadResponseShape = {
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
};

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
  errorsCsvStorageKey: string | null;
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
    errors_csv_s3_key: upload.errorsCsvStorageKey,
    schema_id: upload.schemaId,
    schema_version: upload.schemaVersion,
    created_at: upload.createdAt.toISOString(),
    completed_at: upload.completedAt ? upload.completedAt.toISOString() : null,
  };
}

/**
 * Loads live counters from Redis for an in-flight upload.
 *
 * Returns ZERO_COUNTS when the keys are missing.
 */
async function loadCountsFromRedis(uploadId: string): Promise<UploadCounts> {
  try {
    const redis = getRedis();
    const ns = `bu:${uploadId}`;
    const [counters, meta] = await Promise.all([
      redis.hmget(`${ns}:counters`, 'passed', 'failed', 'skipped'),
      redis.hget(`${ns}:meta`, 'total_rows'),
    ]);
    const passed = Number.parseInt(counters[0] ?? '0', 10) || 0;
    const failed = Number.parseInt(counters[1] ?? '0', 10) || 0;
    const skipped = Number.parseInt(counters[2] ?? '0', 10) || 0;
    const totalRows = meta ? Number.parseInt(meta, 10) || null : null;
    return { totalRows, passed, failed, skipped };
  } catch {
    return ZERO_COUNTS;
  }
}

/**
 * Loads final counters from the `onboarding` row written by `bulk-finalise`.
 *
 * Returns ZERO_COUNTS when the row is missing.
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
  await recordRouteCaller(req, callerFromAuth(result.context));
  return result.context;
}

/**
 * Records the operator's bulk-upload attestation in the consent ledger.
 *
 * The `source` is `bulk_upload:<uploadId>:v<n>`; the terms and privacy
 * versions go in their own columns. Returns `false` on any failure so the
 * caller aborts the upload.
 *
 * @param aggregatorId - The uploading aggregator (ledger subject).
 * @param uploadId - The bulk_uploads row this attestation authorises.
 * @param log - Request-scoped logger.
 * @returns `true` when the ledger row was written; `false` on any failure.
 */
async function recordBulkUploadAttestation({
  aggregatorId,
  uploadId,
  log,
}: {
  aggregatorId: string;
  uploadId: string;
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<boolean> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  let attestationVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    const docs = consentCfg.audiences.aggregator.documents;
    const attestation = docs.bulk_upload_attestation;
    if (!attestation) {
      log.error(
        { operation: 'consentLedger.recordBulkUploadAttestation', status: 'failure' },
        'bulk_upload_attestation not configured for the aggregator audience',
      );
      return false;
    }
    termsVersion = docs.terms.current_version;
    privacyVersion = docs.privacy.current_version;
    attestationVersion = attestation.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: errorMessage(e),
      },
      'consent config load failed — bulk upload rejected',
    );
    return false;
  }

  const result = await getConsentLedger().recordRegistrationConsent({
    subjectType: 'user',
    subjectId: aggregatorId,
    network,
    brand: brand ?? null,
    termsVersion,
    privacyVersion,
    source: `bulk_upload:${uploadId}:v${attestationVersion}`,
  });
  if (!result.success) {
    log.error(
      {
        operation: 'consentLedger.recordBulkUploadAttestation',
        status: 'failure',
        error: result.error.message,
      },
      'attestation ledger write failed — bulk upload rejected',
    );
    return false;
  }
  return true;
}
