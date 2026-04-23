/**
 * Drizzle-backed repository for the export_job table.
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
import { exportJob } from '../schema/export.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type ExportJobEntity = typeof exportJob.$inferSelect;

/** Filter fields supported by ExportJobRepo.findMany. */
export interface ExportJobFilter extends Filter {
  aggregatorId?: string;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
}

/**
 * Repository for async data export jobs.
 *
 * Workers poll findByStatus('pending') to pick up new jobs.
 * file_url is set by the worker when the export is uploaded to object storage.
 */
export class ExportJobRepo extends Repository<ExportJobEntity, string, ExportJobFilter> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<ExportJobEntity | null, BaseError>> {
    try {
      const rows = await this.db.select().from(exportJob).where(eq(exportJob.id, id)).limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('export_job.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(filter: ExportJobFilter): Promise<Result<ExportJobEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(exportJob)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('export_job.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: ExportJobFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<ExportJobEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(exportJob.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(exportJob)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(exportJob)
        .where(and(...conditions))
        .orderBy(desc(exportJob.createdAt))
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
        new UpstreamError('export_job.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(input: CreateInput<ExportJobEntity>): Promise<Result<ExportJobEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(exportJob)
        .values(input as typeof exportJob.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('export_job.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<ExportJobEntity>,
  ): Promise<Result<ExportJobEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(exportJob)
        .set(patch as Partial<typeof exportJob.$inferInsert>)
        .where(eq(exportJob.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('export_job.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('export_job.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(exportJob).where(eq(exportJob.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('export_job.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns export jobs filtered by status, newest first.
   *
   * Primary use: worker polling for 'pending' jobs and admin status dashboards.
   *
   * @param status - Target job lifecycle status.
   * @param paging - Optional cursor-based paging.
   */
  async findByStatus(
    status: 'pending' | 'processing' | 'completed' | 'failed',
    paging?: Paging,
  ): Promise<Result<Paginated<ExportJobEntity>, BaseError>> {
    return this.findMany({ status }, paging);
  }
}

function buildConditions(filter: ExportJobFilter) {
  const conditions = [];
  if (filter.aggregatorId !== undefined) {
    conditions.push(eq(exportJob.aggregatorId, filter.aggregatorId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(exportJob.status, filter.status));
  }
  return conditions;
}
