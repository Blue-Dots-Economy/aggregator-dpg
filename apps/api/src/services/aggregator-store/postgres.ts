/**
 * Postgres adapter for the aggregator store.
 *
 * Wraps Drizzle queries against the `aggregators` table. Driver-level errors
 * are normalised to the abstract `StoreError` codes so callers never see raw
 * pg error fields.
 *
 * Person-contact data is read from the `contact` table through
 * `aggregators.contact_id` (migration 0025) and composed back into the Beckn
 * `contact` shape, so callers and the API contract are unchanged. Writes still
 * go to the legacy `contact` jsonb during the contact rollout; the database
 * sync triggers keep `contact` / `contact_id` / `contact_extra` in step, which
 * is why every write re-reads the row instead of trusting `RETURNING` (the
 * AFTER UPDATE trigger may re-key the contact after the statement returns).
 */

import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { logger } from '../../logger.js';
import { aggregators, contact } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import {
  PG_UNIQUE_VIOLATION,
  PG_CHECK_VIOLATION,
  pgErrorCode,
  pgConstraint,
} from '../../db/pg-error.js';
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
          parentOrgId: input.parentOrgId ?? null,
          inviteEmail: input.inviteEmail ?? null,
          profile: input.profile ?? {},
          profileRef: input.profileRef ?? null,
        })
        .returning({ id: aggregators.id });
      const inserted = rows[0];
      if (!inserted) {
        return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      }
      const created = await this.reread('aggregatorStore.create', inserted.id);
      if (created.ok) {
        logger.info({
          operation: 'aggregatorStore.create',
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: inserted.id,
        });
      }
      return created;
    } catch (err: unknown) {
      return this.mapWriteError('aggregatorStore.create', err, input.orgSlug, start);
    }
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    return this.findOne('aggregatorStore.findById', eq(aggregators.id, id));
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    return this.findOne('aggregatorStore.findBySlug', eq(aggregators.orgSlug, orgSlug));
  }

  async findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>> {
    // The linked contact is authoritative; a row the sync could not link
    // (contact_id NULL) still answers from its legacy column so a duplicate
    // check never misses it.
    return this.findOne(
      'aggregatorStore.findByContactPhone',
      or(
        eq(contact.phone, phone),
        and(isNull(aggregators.contactId), eq(aggregators.contactPhone, phone)),
      )!,
    );
  }

  async findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>> {
    const e = email.trim().toLowerCase();
    return this.findOne(
      'aggregatorStore.findByContactEmail',
      or(
        eq(contact.email, e),
        and(isNull(aggregators.contactId), eq(aggregators.contactEmail, e)),
      )!,
    );
  }

  async findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    try {
      const rows = await this.selectJoined().where(eq(aggregators.parentOrgId, orgId));
      return { ok: true, value: rows.map(toDomain) };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.findByParentOrgId', err);
    }
  }

  async list(filter: ListAggregatorsFilter): Promise<StoreResult<ListAggregatorsPage>> {
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    try {
      const conds = [];
      if (filter.status) conds.push(eq(aggregators.status, filter.status));
      if (filter.actorType) conds.push(eq(aggregators.actorType, filter.actorType));
      if (filter.updatedBefore) conds.push(lt(aggregators.updatedAt, filter.updatedBefore));
      const where = conds.length > 0 ? and(...conds) : undefined;

      const rows = await this.selectJoined()
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
    if (patch.parentOrgId !== undefined) updates['parentOrgId'] = patch.parentOrgId;
    if (patch.rejectedAt !== undefined) updates['rejectedAt'] = patch.rejectedAt;

    try {
      const rows = await getDb()
        .update(aggregators)
        .set(updates)
        .where(eq(aggregators.id, id))
        .returning({ id: aggregators.id });
      if (!rows[0]) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      return this.reread('aggregatorStore.update', id);
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

  async approveFromPending(id: string, updatedBy: string): Promise<StoreResult<Aggregator | null>> {
    try {
      const rows = await getDb()
        .update(aggregators)
        .set({ status: 'active', updatedBy, updatedAt: new Date() })
        .where(and(eq(aggregators.id, id), eq(aggregators.status, 'pending')))
        .returning({ id: aggregators.id });
      // No row → not pending (a concurrent approval already committed).
      if (!rows[0]) return { ok: true, value: null };
      return this.reread('aggregatorStore.approveFromPending', id);
    } catch (err: unknown) {
      return this.mapWriteError('aggregatorStore.approveFromPending', err, id, Date.now());
    }
  }

  async updateSignalstackOrgId(
    id: string,
    signalstackOrgId: string,
    updatedBy: string,
  ): Promise<StoreResult<Aggregator>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .update(aggregators)
        .set({
          signalstackOrgId,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(eq(aggregators.id, id))
        .returning({ id: aggregators.id });
      if (!rows[0]) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      const updated = await this.reread('aggregatorStore.updateSignalstackOrgId', id);
      if (updated.ok) {
        logger.info({
          operation: 'aggregatorStore.updateSignalstackOrgId',
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: id,
        });
      }
      return updated;
    } catch (err: unknown) {
      return this.mapWriteError('aggregatorStore.updateSignalstackOrgId', err, id, start);
    }
  }

  async deleteById(id: string): Promise<StoreResult<void>> {
    try {
      const rows = await getDb()
        .delete(aggregators)
        .where(eq(aggregators.id, id))
        .returning({ id: aggregators.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.deleteById', err);
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** `aggregators` LEFT JOIN `contact` — the one read shape every query uses. */
  private selectJoined() {
    return getDb()
      .select({ a: aggregators, c: contact })
      .from(aggregators)
      .leftJoin(contact, eq(contact.id, aggregators.contactId));
  }

  /** Returns the first row matching `predicate`, or `null`. */
  private async findOne(op: string, predicate: SQL): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await this.selectJoined().where(predicate).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError(op, err);
    }
  }

  /**
   * Re-reads a row just written, so the result reflects what the contact sync
   * triggers did after the statement (a re-key, a relink). A row that vanished
   * in between is reported as `NOT_FOUND`.
   */
  private async reread(op: string, id: string): Promise<StoreResult<Aggregator>> {
    const found = await this.findOne(op, eq(aggregators.id, id));
    if (!found.ok) return found;
    if (!found.value) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
    return { ok: true, value: found.value };
  }

  // ─── Error mapping ────────────────────────────────────────────────────────

  private mapWriteError(
    op: string,
    err: unknown,
    contextId: string,
    start: number,
  ): StoreResult<never> {
    // SQLSTATE `code` + `constraint` come from the shared pg-error helpers,
    // which walk Drizzle's `.cause` chain (the top-level `.message` is only the
    // query text). Gating on the code maps a unique/check violation to a clean
    // 409 rather than a misleading 503.
    const code = pgErrorCode(err);
    const constraint = pgConstraint(err) ?? '';
    const message = (err as Error).message ?? 'unknown';

    if (code === PG_UNIQUE_VIOLATION) {
      // Match each constraint explicitly. Defaulting the unknown case to
      // DUPLICATE_SLUG told the user "that name is already taken" for whatever
      // unique index a later migration happens to add (#718 review); the
      // constraint name is logged below either way.
      let storeCode: StoreError['code'] = 'DUPLICATE';
      if (constraint.includes('contact_phone')) storeCode = 'DUPLICATE_PHONE';
      else if (constraint.includes('contact_email')) storeCode = 'DUPLICATE_EMAIL';
      else if (constraint.includes('slug')) storeCode = 'DUPLICATE_SLUG';
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

type JoinedRow = {
  a: typeof aggregators.$inferSelect;
  c: typeof contact.$inferSelect | null;
};

/**
 * Builds the Beckn `contact` the API has always returned, from the linked
 * `contact` row plus `contact_extra`. Keys are emitted in the order the legacy
 * jsonb column produced them (Postgres orders jsonb keys by length, then
 * bytes), so a serialised response stays byte-identical.
 */
function composeContact(row: JoinedRow): BecknContact {
  const { a, c } = row;
  if (!c) {
    // Unlinked row (contact_id NULL): fall back to the legacy jsonb, which is
    // still written during the contact rollout.
    if (a.contact) return a.contact;
    logger.warn({
      operation: 'aggregatorStore.composeContact',
      status: 'failure',
      error: 'row has neither a linked contact nor a legacy contact',
      aggregator_id: a.id,
    });
    return { name: '', email: '', phone: '' };
  }
  const extra = a.contactExtra ?? {};
  return {
    name: c.name ?? '',
    email: c.email,
    phone: c.phone ?? '',
    ...(extra.company !== undefined ? { company: extra.company } : {}),
    ...(extra.gstNumber !== undefined ? { gstNumber: extra.gstNumber } : {}),
    ...(extra.alternatePhone !== undefined ? { alternatePhone: extra.alternatePhone } : {}),
  };
}

function toDomain(row: JoinedRow): Aggregator {
  const { a } = row;
  // Legacy `'both'` rows are coerced to null at the boundary — the app no
  // longer treats `both` as a first-class participant focus. Backfill the
  // column to a single value before dropping the DB enum entry.
  const type = a.type === 'both' ? null : a.type;
  const composed = composeContact(row);
  return {
    id: a.id,
    orgSlug: a.orgSlug,
    actorType: a.actorType,
    name: a.name,
    type,
    url: a.url,
    contactId: a.contactId,
    contact: composed,
    contactPhone: composed.phone,
    contactEmail: composed.email.toLowerCase(),
    locations: a.locations,
    consent: a.consent,
    profile: a.profile ?? {},
    profileRef: a.profileRef,
    status: a.status,
    createdBy: a.createdBy,
    updatedBy: a.updatedBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    signalstackOrgId: a.signalstackOrgId,
    parentOrgId: a.parentOrgId,
    inviteEmail: a.inviteEmail,
    rejectedAt: a.rejectedAt,
  };
}
