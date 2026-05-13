/**
 * Postgres adapter for the aggregator profile store.
 */

import { eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { aggregatorProfile } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  AggregatorProfileStoreBase,
  type AggregatorProfile,
  type CreateAggregatorProfileInput,
  type ProfileStoreError,
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
        .insert(aggregatorProfile)
        .values({
          aggregatorId: input.aggregatorId,
          contactName: input.contactName ?? null,
          personas: input.personas ?? [],
          services: input.services ?? [],
          verifiedCertificate: input.verifiedCertificate ?? [],
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
      return this.mapWriteError('aggregatorProfileStore.create', err, input.aggregatorId, start);
    }
  }

  async findByAggregatorId(
    aggregatorId: string,
  ): Promise<ProfileStoreResult<AggregatorProfile | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(aggregatorProfile)
        .where(eq(aggregatorProfile.aggregatorId, aggregatorId))
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
      if (input.contactName !== undefined) updateValues['contactName'] = input.contactName;
      if (input.personas !== undefined) updateValues['personas'] = input.personas;
      if (input.services !== undefined) updateValues['services'] = input.services;
      if (input.verifiedCertificate !== undefined)
        updateValues['verifiedCertificate'] = input.verifiedCertificate;
      if (input.profileCompletedAt !== undefined)
        updateValues['profileCompletedAt'] = input.profileCompletedAt;

      const rows = await getDb()
        .update(aggregatorProfile)
        .set(updateValues)
        .where(eq(aggregatorProfile.aggregatorId, aggregatorId))
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
      return this.mapWriteError('aggregatorProfileStore.update', err, aggregatorId, start);
    }
  }

  async markCompleted(
    aggregatorId: string,
    updatedBy: string,
  ): Promise<ProfileStoreResult<AggregatorProfile>> {
    return this.update(aggregatorId, { profileCompletedAt: new Date(), updatedBy });
  }

  async deleteByAggregatorId(aggregatorId: string): Promise<ProfileStoreResult<void>> {
    try {
      const rows = await getDb()
        .delete(aggregatorProfile)
        .where(eq(aggregatorProfile.aggregatorId, aggregatorId))
        .returning();
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: aggregatorId } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      logger.error({
        operation: 'aggregatorProfileStore.deleteByAggregatorId',
        status: 'failure',
        error: (err as Error).message,
      });
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (err as Error).message } };
    }
  }

  private mapWriteError(
    op: string,
    err: unknown,
    contextId: string,
    start: number,
  ): ProfileStoreResult<never> {
    const code = (err as { code?: string }).code;
    const message = (err as Error).message ?? 'unknown';
    if (code === PG_UNIQUE_VIOLATION) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'DUPLICATE',
        latency_ms: Date.now() - start,
      });
      return {
        ok: false,
        error: { code: 'DUPLICATE', message: `profile exists for ${contextId}` },
      };
    }
    if (code === PG_FK_VIOLATION) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'FOREIGN_KEY_VIOLATION',
        latency_ms: Date.now() - start,
      });
      return {
        ok: false,
        error: {
          code: 'FOREIGN_KEY_VIOLATION',
          message: `aggregator ${contextId} not found`,
        } satisfies ProfileStoreError,
      };
    }
    logger.error({
      operation: op,
      status: 'failure',
      error: message,
      error_type: (err as Error).constructor?.name,
      latency_ms: Date.now() - start,
    });
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message } };
  }
}

function toDomain(row: typeof aggregatorProfile.$inferSelect): AggregatorProfile {
  return {
    aggregatorId: row.aggregatorId,
    contactName: row.contactName,
    personas: row.personas,
    services: row.services,
    verifiedCertificate: row.verifiedCertificate,
    profileCompletedAt: row.profileCompletedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
