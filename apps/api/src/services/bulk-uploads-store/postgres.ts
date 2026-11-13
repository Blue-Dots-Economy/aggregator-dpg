/**
 * Postgres adapter for the bulk uploads store.
 *
 * Wraps Drizzle queries against `bulk_uploads`. All errors map to the
 * `StoreError` codes.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
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
import { errorMessage, errorType } from '@aggregator-dpg/shared-primitives/errors';

export class PostgresBulkUploadsStore extends BulkUploadsStoreBase {
  async create(input: CreateBulkUploadInput): Promise<StoreResult<BulkUpload>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(bulkUploads)
        .values({
          userId: input.aggregatorId,
          participantType: input.participantType,
          storageKey: input.storageKey,
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
        aggregator_id: row.userId,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.create',
        status: 'failure',
        error: errorMessage(err),
        error_type: errorType(err),
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  async findById(id: string, aggregatorId: string): Promise<StoreResult<BulkUpload | null>> {
    try {
      const rows = await getDb()
        .select()
        .from(bulkUploads)
        .where(and(eq(bulkUploads.id, id), eq(bulkUploads.userId, aggregatorId)))
        .limit(1);
      const row = rows[0];
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.findById',
        status: 'failure',
        error: errorMessage(err),
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  async list(
    aggregatorId: string,
    options: ListBulkUploadsOptions,
  ): Promise<StoreResult<ListBulkUploadsResult>> {
    try {
      const where = and(
        eq(bulkUploads.userId, aggregatorId),
        ne(bulkUploads.status, 'pending'),
        or(isNull(bulkUploads.statusReason), ne(bulkUploads.statusReason, 'upload_abandoned')),
      );
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
        error: errorMessage(err),
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  async deletePending(id: string, aggregatorId: string): Promise<StoreResult<void>> {
    try {
      await getDb()
        .delete(bulkUploads)
        .where(
          and(
            eq(bulkUploads.id, id),
            eq(bulkUploads.userId, aggregatorId),
            eq(bulkUploads.status, 'pending'),
          ),
        );
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      logger.error({
        operation: 'bulkUploadsStore.deletePending',
        status: 'failure',
        error: errorMessage(err),
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }

  async markUploaded(
    id: string,
    aggregatorId: string,
    contentFingerprint: string,
  ): Promise<StoreResult<BulkUpload>> {
    const start = Date.now();
    // Read the current state, then write with a status guard.
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
    if (current.status === 'uploaded' && current.contentFingerprint === contentFingerprint) {
      return { ok: true, value: current };
    }
    try {
      // The status guard stops a concurrent caller moving a later row back to `uploaded`.
      const rows = await getDb()
        .update(bulkUploads)
        .set({ status: 'uploaded', contentFingerprint, updatedAt: new Date() })
        .where(
          and(
            eq(bulkUploads.id, id),
            eq(bulkUploads.userId, aggregatorId),
            inArray(bulkUploads.status, ['pending', 'uploaded']),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        // The status moved on between the read and the write.
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
      logger.error({
        operation: 'bulkUploadsStore.markUploaded',
        status: 'failure',
        error: errorMessage(err),
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: errorMessage(err) } };
    }
  }
}

function toDomain(row: BulkUploadRow): BulkUpload {
  return {
    id: row.id,
    aggregatorId: row.userId,
    participantType: row.participantType,
    storageKey: row.storageKey,
    contentFingerprint: row.contentFingerprint,
    status: row.status,
    statusReason: row.statusReason,
    errorsCsvStorageKey: row.errorsCsvStorageKey,
    schemaId: row.schemaId,
    schemaVersion: row.schemaVersion,
    uploadedBy: row.uploadedBy,
    lastProgressAt: row.lastProgressAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
