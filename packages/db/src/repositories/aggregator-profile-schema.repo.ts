/**
 * Drizzle-backed repository for the aggregator_profile_schema table.
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
import { aggregatorProfileSchema } from '../schema/aggregator.js';
import type { DrizzleDB } from '../postgres/drizzle.js';
import { decodeCursor } from './_cursor.js';
import { buildPaginated, resolveLimit } from './_paginate.js';

export type AggregatorProfileSchemaEntity = typeof aggregatorProfileSchema.$inferSelect;

/** Filter fields supported by AggregatorProfileSchemaRepo.findMany. */
export interface AggregatorProfileSchemaFilter extends Filter {
  active?: boolean;
  version?: string;
}

/**
 * Repository for versioned JSON schema definitions used to validate
 * aggregator profile data.
 */
export class AggregatorProfileSchemaRepo extends Repository<
  AggregatorProfileSchemaEntity,
  string,
  AggregatorProfileSchemaFilter
> {
  constructor(private readonly db: DrizzleDB) {
    super();
  }

  async getById(id: string): Promise<Result<AggregatorProfileSchemaEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(aggregatorProfileSchema)
        .where(eq(aggregatorProfileSchema.id, id))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.getById failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findOne(
    filter: AggregatorProfileSchemaFilter,
  ): Promise<Result<AggregatorProfileSchemaEntity | null, BaseError>> {
    try {
      const conditions = buildConditions(filter);
      const rows = await this.db
        .select()
        .from(aggregatorProfileSchema)
        .where(and(...conditions))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.findOne failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async findMany(
    filter: AggregatorProfileSchemaFilter,
    paging?: Paging,
  ): Promise<Result<Paginated<AggregatorProfileSchemaEntity>, BaseError>> {
    try {
      const limit = resolveLimit(paging);
      const conditions = buildConditions(filter);

      if (paging?.cursor) {
        const { createdAt } = decodeCursor(paging.cursor);
        conditions.push(lt(aggregatorProfileSchema.createdAt, createdAt));
      }

      const [countRow] = await this.db
        .select({ total: count() })
        .from(aggregatorProfileSchema)
        .where(and(...buildConditions(filter)));
      const total = Number(countRow?.total ?? 0);

      const items = await this.db
        .select()
        .from(aggregatorProfileSchema)
        .where(and(...conditions))
        .orderBy(desc(aggregatorProfileSchema.createdAt))
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
        new UpstreamError('aggregator_profile_schema.findMany failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async create(
    input: CreateInput<AggregatorProfileSchemaEntity>,
  ): Promise<Result<AggregatorProfileSchemaEntity, BaseError>> {
    try {
      const [row] = await this.db
        .insert(aggregatorProfileSchema)
        .values(input as typeof aggregatorProfileSchema.$inferInsert)
        .returning();
      return ok(row!);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.create failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async update(
    id: string,
    patch: UpdateInput<AggregatorProfileSchemaEntity>,
  ): Promise<Result<AggregatorProfileSchemaEntity, BaseError>> {
    try {
      const [row] = await this.db
        .update(aggregatorProfileSchema)
        .set(patch as Partial<typeof aggregatorProfileSchema.$inferInsert>)
        .where(eq(aggregatorProfileSchema.id, id))
        .returning();
      if (!row) {
        return err(
          new UpstreamError('aggregator_profile_schema.update: row not found', {
            code: 'DB_NOT_FOUND',
            details: { id },
          }),
        );
      }
      return ok(row);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.update failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  async delete(id: string): Promise<Result<void, BaseError>> {
    try {
      await this.db.delete(aggregatorProfileSchema).where(eq(aggregatorProfileSchema.id, id));
      return ok(undefined);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.delete failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Returns the currently active schema version, or null if none is active.
   *
   * Only one schema version should be active at a time; enforced at
   * application layer via this query + a deactivate step before activating.
   */
  async findActive(): Promise<Result<AggregatorProfileSchemaEntity | null, BaseError>> {
    try {
      const rows = await this.db
        .select()
        .from(aggregatorProfileSchema)
        .where(eq(aggregatorProfileSchema.active, true))
        .limit(1);
      return ok(rows[0] ?? null);
    } catch (e) {
      return err(
        new UpstreamError('aggregator_profile_schema.findActive failed', {
          code: 'DB_QUERY_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }
}

function buildConditions(filter: AggregatorProfileSchemaFilter) {
  const conditions = [];
  if (filter.active !== undefined) {
    conditions.push(eq(aggregatorProfileSchema.active, filter.active));
  }
  if (filter.version !== undefined) {
    conditions.push(eq(aggregatorProfileSchema.version, filter.version));
  }
  return conditions;
}
