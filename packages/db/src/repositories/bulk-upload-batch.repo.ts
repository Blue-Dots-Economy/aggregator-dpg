/**
 * Drizzle-backed repository for the bulk_upload_batch table.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import { and, count, desc, eq, lt } from 'drizzle-orm';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { bulkUploadBatch } from '../schema/bulk-upload.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type BulkUploadBatchEntity = typeof bulkUploadBatch.$inferSelect;

/** Filter fields supported by BulkUploadBatchRepo.findMany. */
export interface BulkUploadBatchFilter extends Filter {
  aggregatorId?: string;
}

/**
 * Repository for CSV bulk-upload batch records.
 */
export class BulkUploadBatchRepo extends Repository<
  BulkUploadBatchEntity,
  string,
  BulkUploadBatchFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<BulkUploadBatchEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(bulkUploadBatch)
        .where(eq(bulkUploadBatch.id, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: BulkUploadBatchFilter,
  ): Promise<Result<BulkUploadBatchEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(bulkUploadBatch)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: BulkUploadBatchFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadBatchEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(bulkUploadBatch.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(bulkUploadBatch)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(bulkUploadBatch)
        .where(and(...conditions))
        .orderBy(desc(bulkUploadBatch.createdAt))
        .limit(limit);

      return ok(
        buildPaginated(
          items,
          total,
          limit,
          (i) => i.id,
          (i) => i.createdAt,
        ),
      );
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<BulkUploadBatchEntity>,
  ): Promise<Result<BulkUploadBatchEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(bulkUploadBatch)
        .values(input as typeof bulkUploadBatch.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<BulkUploadBatchEntity>,
  ): Promise<Result<BulkUploadBatchEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(bulkUploadBatch)
        .set(patch as Partial<typeof bulkUploadBatch.$inferInsert>)
        .where(eq(bulkUploadBatch.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('bulk_upload_batch.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(bulkUploadBatch).where(eq(bulkUploadBatch.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_batch.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns all batches for a given aggregator, newest first.
   *
   * @param aggregatorId - UUID of the aggregator organisation.
   * @param paging - Optional cursor-based paging options.
   */
  async findByAggregator(
    aggregatorId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadBatchEntity>, BaseError>> {
    return this.findMany({ aggregatorId }, paging);
  }
}

function buildConditions(filter: BulkUploadBatchFilter) {
  const conditions = [];
  if (filter.aggregatorId !== undefined) {
    conditions.push(eq(bulkUploadBatch.aggregatorId, filter.aggregatorId));
  }
  return conditions;
}
