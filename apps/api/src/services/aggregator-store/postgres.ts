/**
 * Postgres adapter for the aggregator store.
 *
 * Wraps Drizzle queries against the `aggregators` table. Driver-level errors
 * are normalised to the abstract `StoreError` codes so callers never see raw
 * pg error fields.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { aggregators } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  AggregatorStoreBase,
  type Aggregator,
  type CreateAggregatorInput,
  type ListAggregatorsFilter,
  type ListAggregatorsPage,
  type StoreError,
  type StoreResult,
  type UpdateAggregatorPatch,
} from './interface.js';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';

const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';

export class PostgresAggregatorStore extends AggregatorStoreBase {
  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(aggregators)
        .values({
          orgSlug: input.orgSlug,
          actorType: input.actorType,
          name: input.name,
          type: input.type ?? null,
          url: input.url ?? null,
          contact: input.contact,
          locations: input.locations ?? [],
          consent: input.consent,
          createdBy: input.createdBy,
          updatedBy: input.updatedBy,
        })
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
      return this.mapWriteError('aggregatorStore.create', err, input.orgSlug, start);
    }
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await getDb().select().from(aggregators).where(eq(aggregators.id, id)).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.findById', err);
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
      return this.mapReadError('aggregatorStore.findBySlug', err);
    }
  }

  async findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(aggregators)
        .where(eq(aggregators.contactPhone, phone))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.findByContactPhone', err);
    }
  }

  async findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(aggregators)
        .where(eq(aggregators.contactEmail, email.toLowerCase()))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.findByContactEmail', err);
    }
  }

  async list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    try {
      const conds = [];
      if (filter.status) conds.push(eq(aggregators.status, filter.status));
      if (filter.actorType) conds.push(eq(aggregators.actorType, filter.actorType));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const rows = await getDb()
        .select()
        .from(aggregators)
        .where(where)
        .orderBy(desc(aggregators.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await getDb()
        .select({ total: sql<number>`count(*)::int` })
        .from(aggregators)
        .where(where);
      const total = totals[0]?.total ?? 0;
      return { ok: true, value: { rows: rows.map(toDomain), total } };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.list', err);
    }
  }

  async update(id: string, patch: UpdateAggregatorPatch): Promise<StoreResult<Aggregator>> {
    const updates: Record<string, unknown> = {
      updatedBy: patch.updatedBy,
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) updates['name'] = patch.name;
    if (patch.type !== undefined) updates['type'] = patch.type;
    if (patch.url !== undefined) updates['url'] = patch.url;
    if (patch.contact !== undefined) updates['contact'] = patch.contact;
    if (patch.locations !== undefined) updates['locations'] = patch.locations;
    if (patch.consent !== undefined) updates['consent'] = patch.consent;
    if (patch.status !== undefined) updates['status'] = patch.status;

    try {
      const rows = await getDb()
        .update(aggregators)
        .set(updates)
        .where(eq(aggregators.id, id))
        .returning();
      const row = rows[0];
      if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      return { ok: true, value: toDomain(row) };
    } catch (err: unknown) {
      return this.mapWriteError('aggregatorStore.update', err, id, Date.now());
    }
  }

  async updateStatus(
    id: string,
    status: AggregatorStatus,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    return this.update(id, { status, updatedBy });
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    try {
      const rows = await getDb().delete(aggregators).where(eq(aggregators.id, id)).returning();
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.deleteById', err);
    }
  }

  // ─── Error mapping ────────────────────────────────────────────────────────

  private mapWriteError(
    op: string,
    err: unknown,
    contextId: string,
    start: number,
  ): StoreResult<never> {
    const code = (err as { code?: string }).code;
    const constraint = (err as { constraint?: string }).constraint ?? '';
    const message = (err as Error).message ?? 'unknown';

    if (code === PG_UNIQUE_VIOLATION) {
      let storeCode: StoreError['code'] = 'DUPLICATE_SLUG';
      if (constraint.includes('contact_phone')) storeCode = 'DUPLICATE_PHONE';
      else if (constraint.includes('contact_email')) storeCode = 'DUPLICATE_EMAIL';
      logger.warn({
        operation: op,
        status: 'failure',
        error: storeCode,
        constraint,
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: storeCode, message: `${storeCode}: ${contextId}` } };
    }
    if (code === PG_CHECK_VIOLATION) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'CHECK_VIOLATION',
        constraint,
        latency_ms: Date.now() - start,
      });
      return {
        ok: false,
        error: { code: 'CHECK_VIOLATION', message: `${constraint || 'check_violation'}` },
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

  private mapReadError(op: string, err: unknown): StoreResult<never> {
    const message = (err as Error).message ?? 'unknown';
    logger.error({ operation: op, status: 'failure', error: message });
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message } };
  }
}

function toDomain(row: typeof aggregators.$inferSelect): Aggregator {
  return {
    id: row.id,
    orgSlug: row.orgSlug,
    actorType: row.actorType,
    name: row.name,
    type: row.type,
    url: row.url,
    contact: row.contact,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    locations: row.locations,
    consent: row.consent,
    status: row.status,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
