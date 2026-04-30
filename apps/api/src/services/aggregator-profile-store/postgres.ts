/**
 * Postgres adapter for the aggregator profile store.
 */

import { eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { aggregatorProfiles } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  AggregatorProfileStoreBase,
  type AggregatorProfile,
  type CreateAggregatorProfileInput,
  type ProfileStoreResult,
  type UpdateAggregatorProfileInput,
} from './interface.js';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';

export class PostgresAggregatorProfileStore extends AggregatorProfileStoreBase {
  async create(
    input: CreateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(aggregatorProfiles)
        .values({
          aggregatorId: input.aggregatorId,
          schemaVersion: input.schemaVersion ?? 1,
          data: input.data ?? {},
          consent: input.consent ?? {},
          createdBy: input.createdBy,
          updatedBy: input.updatedBy,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      logger.info({
        operation: 'aggregatorProfileStore.create',
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: row.aggregatorId,
      });
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === PG_UNIQUE_VIOLATION) {
        return {
          ok: false,
          error: { code: 'DUPLICATE', message: `profile exists for ${input.aggregatorId}` },
        };
      }
      if (code === PG_FK_VIOLATION) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `aggregator ${input.aggregatorId} not found` },
        };
      }
      logger.error({
        operation: 'aggregatorProfileStore.create',
        status: 'failure',
        error: (err as Error).message,
        error_type: (err as Error).constructor.name,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async findByAggregatorId(
    aggregatorId: string,
  ): Promise<ProfileStoreResult<AggregatorProfile | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(aggregatorProfiles)
        .where(eq(aggregatorProfiles.aggregatorId, aggregatorId))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorProfileStore.findByAggregatorId',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  async update(
    aggregatorId: string,
    input: UpdateAggregatorProfileInput,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    const start = Date.now();
    try {
      const updateValues: Record<string, unknown> = {
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      };
      if (input.schemaVersion !== undefined) updateValues.schemaVersion = input.schemaVersion;
      if (input.data !== undefined) updateValues.data = input.data;
      if (input.consent !== undefined) updateValues.consent = input.consent;

      const rows = await getDb()
        .update(aggregatorProfiles)
        .set(updateValues)
        .where(eq(aggregatorProfiles.aggregatorId, aggregatorId))
        .returning();

      const updated = rows[0];
      if (!updated) {
        return { ok: false, error: { code: 'NOT_FOUND', message: aggregatorId } };
      }
      logger.info({
        operation: 'aggregatorProfileStore.update',
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: aggregatorId,
      });
      return { ok: true, value: toDomain(updated) };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorProfileStore.update',
        status: 'failure',
        error: (err as Error).message,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }
}

function toDomain(row: typeof aggregatorProfiles.$inferSelect): AggregatorProfile {
  return {
    aggregatorId: row.aggregatorId,
    schemaVersion: row.schemaVersion,
    data: row.data,
    consent: row.consent,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
