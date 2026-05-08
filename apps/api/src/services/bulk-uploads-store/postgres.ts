/**
 * Postgres adapter for the bulk uploads store.
 *
 * Wraps Drizzle queries against `bulk_uploads`. All errors map to the
 * abstract `StoreError` codes — no driver-specific errors leak.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { bulkUploads, type BulkUploadRow } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  BulkUploadsStoreBase,
  type BulkUpload,
  type CreateBulkUploadInput,
  type ListBulkUploadsOptions,
  type ListBulkUploadsResult,
  type StoreResult,
} from './interface.js';

const PG_UNIQUE_VIOLATION = '23505';

export class PostgresBulkUploadsStore extends BulkUploadsStoreBase {
  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(bulkUploads)
        .values({
          aggregatorId: input.aggregatorId,
          participantType: input.participantType,
          s3Key: input.s3Key,
          schemaId: input.schemaId,
          schemaVersion: input.schemaVersion,
          uploadedBy: input.uploadedBy,
          // status defaults to 'pending' via the column default.
        })
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      logger.info({
        operation: 'bulkUploadsStore.create',
        status: 'success',
        latency_ms: Date.now() - start,
        upload_id: row.id,
        aggregator_id: row.aggregatorId,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.create',
        status: 'failure',
        error: (err as Error).message,
        error_type: (err as Error).constructor.name,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>> {
    try {
      const rows = await getDb()
        .select()
        .from(bulkUploads)
        .where(and(eq(bulkUploads.id, id), eq(bulkUploads.aggregatorId, aggregatorId)))
        .limit(1);
      const row = rows[0];
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.findById',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findByAggregatorAndEtag(
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload | null>> {
    try {
      const rows = await getDb()
        .select()
        .from(bulkUploads)
        .where(and(eq(bulkUploads.aggregatorId, aggregatorId), eq(bulkUploads.s3Etag, s3Etag)))
        .limit(1);
      const row = rows[0];
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.findByAggregatorAndEtag',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>> {
    try {
      const where = eq(bulkUploads.aggregatorId, aggregatorId);
      const [rows, totalRows] = await Promise.all([
        getDb()
          .select()
          .from(bulkUploads)
          .where(where)
          .orderBy(desc(bulkUploads.createdAt))
          .limit(options.limit)
          .offset(options.offset),
        getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(bulkUploads)
          .where(where),
      ]);
      const total = totalRows[0]?.count ?? 0;
      return { ok: true, value: { rows: rows.map(toDomain), total } };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.list',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>> {
    try {
      await getDb()
        .delete(bulkUploads)
        .where(
          and(
            eq(bulkUploads.id, id),
            eq(bulkUploads.aggregatorId, aggregatorId),
            eq(bulkUploads.status, 'pending'),
          ),
        );
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.deletePending',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async markUploaded(
    id: string,
    aggregatorId: string,
    s3Etag: string,
  ): Promise<StoreResult<BulkUpload>> {
    const start = Date.now();
    // Two-step: read current state, decide transition, write atomically with
    // a status guard. Using UPDATE...WHERE status='pending' OR status='uploaded'
    // makes replay safe.
    const existing = await this.findById(id, aggregatorId);
    if (!existing.ok) return existing;
    if (!existing.value) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `upload not found: ${id}` } };
    }
    const current = existing.value;
    if (current.status !== 'pending' && current.status !== 'uploaded') {
      return {
        ok: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `cannot mark uploaded from status=${current.status}`,
        },
      };
    }
    // Idempotent: if already uploaded with the same etag, just return.
    if (current.status === 'uploaded' && current.s3Etag === s3Etag) {
      return { ok: true, value: current };
    }
    try {
      // SQL guard the transition — without `status IN ('pending','uploaded')`
      // a concurrent caller racing past row_processing/completed could
      // clobber the row back to `uploaded`.
      const rows = await getDb()
        .update(bulkUploads)
        .set({ status: 'uploaded', s3Etag, updatedAt: new Date() })
        .where(
          and(
            eq(bulkUploads.id, id),
            eq(bulkUploads.aggregatorId, aggregatorId),
            inArray(bulkUploads.status, ['pending', 'uploaded']),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        // Row exists (we read it above) but status moved past pending/uploaded
        // between the read and the write. Treat as a stale-replay invalid
        // transition rather than DB unavailability.
        return {
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `markUploaded raced — row no longer in pending/uploaded`,
          },
        };
      }
      logger.info({
        operation: 'bulkUploadsStore.markUploaded',
        status: 'success',
        latency_ms: Date.now() - start,
        upload_id: id,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return {
          ok: false,
          error: {
            code: 'DUPLICATE_ETAG',
            message: 'aggregator already has an upload with this S3 ETag',
          },
        };
      }
      logger.error({
        operation: 'bulkUploadsStore.markUploaded',
        status: 'failure',
        error: (err as Error).message,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }
}

function toDomain(row: BulkUploadRow): BulkUpload {
  return {
    id: row.id,
    aggregatorId: row.aggregatorId,
    participantType: row.participantType,
    s3Key: row.s3Key,
    s3Etag: row.s3Etag,
    status: row.status,
    statusReason: row.statusReason,
    totalRows: row.totalRows,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    errorsCsvS3Key: row.errorsCsvS3Key,
    schemaId: row.schemaId,
    schemaVersion: row.schemaVersion,
    uploadedBy: row.uploadedBy,
    lastProgressAt: row.lastProgressAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
