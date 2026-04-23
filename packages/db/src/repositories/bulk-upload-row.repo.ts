/**
 * Drizzle-backed repository for the bulk_upload_row table.
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
import { bulkUploadRow } from '../schema/bulk-upload.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type BulkUploadRowEntity = typeof bulkUploadRow.$inferSelect;

/** Filter fields supported by BulkUploadRowRepo.findMany. */
export interface BulkUploadRowFilter extends Filter {
  batchId?: string;
  outcome?: 'success' | 'flagged' | 'error';
}

/**
 * Repository for per-row outcomes within a bulk upload batch.
 *
 * Rows cascade-delete with their parent batch. The default and max limits
 * are higher than other repos because callers typically need all rows for
 * a batch in a single call.
 */
export class BulkUploadRowRepo extends Repository<
  BulkUploadRowEntity,
  string,
  BulkUploadRowFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<BulkUploadRowEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(bulkUploadRow)
        .where(eq(bulkUploadRow.id, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_row.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: BulkUploadRowFilter,
  ): Promise<Result<BulkUploadRowEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(bulkUploadRow)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_row.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: BulkUploadRowFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadRowEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging, 100, 500);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(bulkUploadRow.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(bulkUploadRow)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(bulkUploadRow)
        .where(and(...conditions))
        .orderBy(desc(bulkUploadRow.rowNumber))
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
        new UpstreamError('bulk_upload_row.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<BulkUploadRowEntity>,
  ): Promise<Result<BulkUploadRowEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(bulkUploadRow)
        .values(input as typeof bulkUploadRow.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_row.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<BulkUploadRowEntity>,
  ): Promise<Result<BulkUploadRowEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(bulkUploadRow)
        .set(patch as Partial<typeof bulkUploadRow.$inferInsert>)
        .where(eq(bulkUploadRow.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('bulk_upload_row.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_row.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(bulkUploadRow).where(eq(bulkUploadRow.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('bulk_upload_row.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns all rows for a batch, ordered by row_number ascending.
   *
   * @param batchId - UUID of the parent bulk_upload_batch.
   * @param paging - Optional cursor-based paging for large batches.
   */
  async findByBatch(
    batchId: string,
    paging?: Paging,
  ): Promise<Result<Paginated<BulkUploadRowEntity>, BaseError>> {
    return this.findMany({ batchId }, paging);
  }
}

function buildConditions(filter: BulkUploadRowFilter) {
  const conditions = [];
  if (filter.batchId !== undefined) {
    conditions.push(eq(bulkUploadRow.batchId, filter.batchId));
  }
  if (filter.outcome !== undefined) {
    conditions.push(eq(bulkUploadRow.outcome, filter.outcome));
  }
  return conditions;
}
