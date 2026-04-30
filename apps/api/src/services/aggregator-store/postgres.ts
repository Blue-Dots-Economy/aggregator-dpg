/**
 * Postgres adapter for the aggregator store.
 *
 * Wraps Drizzle queries against the `aggregators` table. All errors map to
 * the abstract `StoreError` codes — no driver-specific errors leak.
 */

import { eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { aggregators } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  AggregatorStoreBase,
  type Aggregator,
  type CreateAggregatorInput,
  type StoreResult,
} from './interface.js';

const PG_UNIQUE_VIOLATION = '23505';

export class PostgresAggregatorStore extends AggregatorStoreBase {
  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(aggregators)
        .values({ orgSlug: input.orgSlug, type: input.type })
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      logger.info({
        operation: 'aggregatorStore.create',
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: row.id,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        logger.warn({
          operation: 'aggregatorStore.create',
          status: 'failure',
          error: 'duplicate slug',
          latency_ms: Date.now() - start,
        });
        return {
          ok: false,
          error: { code: 'DUPLICATE_SLUG', message: `slug already exists: ${input.orgSlug}` },
        };
      }
      logger.error({
        operation: 'aggregatorStore.create',
        status: 'failure',
        error: (err as Error).message,
        error_type: (err as Error).constructor.name,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await getDb().select().from(aggregators).where(eq(aggregators.id, id)).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorStore.findById',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(aggregators)
        .where(eq(aggregators.orgSlug, orgSlug))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorStore.findBySlug',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    try {
      const rows = await getDb().delete(aggregators).where(eq(aggregators.id, id)).returning();
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorStore.deleteById',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }
}

function toDomain(row: typeof aggregators.$inferSelect): Aggregator {
  return {
    id: row.id,
    orgSlug: row.orgSlug,
    type: row.type,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
