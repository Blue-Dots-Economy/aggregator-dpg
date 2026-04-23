/**
 * Drizzle-backed repository for the aggregator_profile table.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

import { and, count, desc, eq, lt, sql } from 'drizzle-orm';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Filter, Paginated, Paging } from '@aggregator-dpg/shared-primitives/dto';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { CreateInput, UpdateInput } from '../interface.js';
import { Repository } from '../interface.js';
import { aggregatorProfile } from '../schema/aggregator.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type AggregatorProfileEntity = typeof aggregatorProfile.$inferSelect;

/** Filter fields supported by AggregatorProfileRepo.findMany. */
export interface AggregatorProfileFilter extends Filter {
  schemaVersion?: string;
}

/**
 * Repository for aggregator organisation profiles.
 *
 * aggregator_id is the stable UUID PK — other tables FK to this column.
 * update() automatically refreshes updatedAt to now().
 */
export class AggregatorProfileRepo extends Repository<
  AggregatorProfileEntity,
  string,
  AggregatorProfileFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<AggregatorProfileEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(aggregatorProfile)
        .where(eq(aggregatorProfile.aggregatorId, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: AggregatorProfileFilter,
  ): Promise<Result<AggregatorProfileEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(aggregatorProfile)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: AggregatorProfileFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<AggregatorProfileEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(aggregatorProfile.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(aggregatorProfile)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(aggregatorProfile)
        .where(and(...conditions))
        .orderBy(desc(aggregatorProfile.createdAt))
        .limit(limit);

      return ok(
        buildPaginated(
          items,
          total,
          limit,
          (i) => i.aggregatorId,
          (i) => i.createdAt,
        ),
      );
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<AggregatorProfileEntity>,
  ): Promise<Result<AggregatorProfileEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(aggregatorProfile)
        .values(input as typeof aggregatorProfile.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<AggregatorProfileEntity>,
  ): Promise<Result<AggregatorProfileEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(aggregatorProfile)
        .set({
          ...(patch as Partial<typeof aggregatorProfile.$inferInsert>),
          updatedAt: sql`now()`,
        })
        .where(eq(aggregatorProfile.aggregatorId, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('aggregator_profile.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(aggregatorProfile).where(eq(aggregatorProfile.aggregatorId, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns all profiles referencing a specific schema version.
   *
   * Used to check whether a schema version is still in use before deactivating it.
   *
   * @param schemaVersionId - UUID of the aggregator_profile_schema row.
   */
  async findBySchemaVersion(
    schemaVersionId: string,
  ): Promise<Result<AggregatorProfileEntity[], BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(aggregatorProfile)
        .where(eq(aggregatorProfile.schemaVersion, schemaVersionId));
      return ok(rows);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile.findBySchemaVersion failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }
}

function buildConditions(filter: AggregatorProfileFilter) {
  const conditions = [];
  if (filter.schemaVersion !== undefined) {
    conditions.push(eq(aggregatorProfile.schemaVersion, filter.schemaVersion));
  }
  return conditions;
}
