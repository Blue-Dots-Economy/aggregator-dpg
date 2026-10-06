/**
 * Postgres adapter for the aggregator store.
 *
 * Wraps Drizzle queries against the `users` table. Driver-level errors
 * are normalised to the abstract `StoreError` codes so callers never see raw
 * pg error fields.
 *
 * Person-contact data is read from the `contact` table through
 * `aggregators.contact_id` (migrations 0025/0026) and composed back into the
 * Beckn `contact` shape, so callers and the API contract are unchanged. Writes
 * go to `contact` in the same transaction as the row (`db/contact-writes.ts`),
 * and every write re-reads the joined row, because `RETURNING` cannot include
 * the joined contact.
 *
 * Org details (`url`, `locations`, company / GST) are rendered from the joined
 * org with the `legacy_org_details` fallback (`org-details.ts`, migration 0028).
 */

import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { AggregatorStatus, BecknContact } from '@aggregator-dpg/shared-primitives/aggregator';
import { logger } from '../../logger.js';
import { users, contact, organisations } from '../../db/schema.js';
import { DEFAULT_ORG_SLUG } from '../aggregator-org-store/interface.js';
import { renderOrgDetails } from './org-details.js';
import {
  changeContact,
  ContactTakenError,
  linkContact,
  SharedContactError,
  splitBecknContact,
  type DbExecutor,
} from '../../db/contact-writes.js';
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

export class PostgresAggregatorStore extends AggregatorStoreBase {
  async create(input: CreateAggregatorInput): Promise<StoreResult<Aggregator>> {
    const start = Date.now();
    let created: Aggregator | null;
    try {
      // The contact and the row that references it are written atomically.
      created = await getDb().transaction(async (tx) => {
        const { identity, extra } = splitBecknContact(input.contact);
        const contactId = await linkContact(tx, identity);
        const rows = await tx
          .insert(users)
          .values({
            userType: 'coordinator',
            orgSlug: input.orgSlug,
            actorType: input.actorType,
            name: input.name,
            type: input.type ?? null,
            contactId,
            contactExtra: onlyAlternatePhone(extra),
            consent: input.consent,
            createdBy: input.createdBy,
            updatedBy: input.updatedBy,
            orgId: input.orgId,
            legacyOrgDetails: input.legacyOrgDetails ?? null,
            inviteEmail: input.inviteEmail ?? null,
            profile: input.profile ?? {},
            profileRef: input.profileRef ?? null,
          })
          .returning({ id: users.id });
        return rows[0] ? this.readIn(tx, rows[0].id) : null;
      });
    } catch (err: unknown) {
      return this.mapWriteError('aggregatorStore.create', err, input.orgSlug, start);
    }
    if (!created) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
    }
    logger.info({
      operation: 'aggregatorStore.create',
      status: 'success',
      latency_ms: Date.now() - start,
      aggregator_id: created.id,
    });
    return { ok: true, value: created };
  }

  async findById(id: string): Promise<StoreResult<Aggregator | null>> {
    return this.findOne('aggregatorStore.findById', eq(users.id, id));
  }

  async findBySlug(orgSlug: string): Promise<StoreResult<Aggregator | null>> {
    return this.findOne('aggregatorStore.findBySlug', eq(users.orgSlug, orgSlug));
  }

  async findByContactPhone(phone: string): Promise<StoreResult<Aggregator | null>> {
    // `contact_id = (subselect)` keeps both lookups on their unique indexes.
    return this.findOne(
      'aggregatorStore.findByContactPhone',
      eq(
        users.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.phone} = ${phone})`,
      ),
    );
  }

  async findByContactEmail(email: string): Promise<StoreResult<Aggregator | null>> {
    const e = email.trim().toLowerCase();
    return this.findOne(
      'aggregatorStore.findByContactEmail',
      eq(
        users.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.email} = ${e})`,
      ),
    );
  }

  async findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    try {
      const rows = await this.selectJoined().where(coordinator(eq(users.orgId, orgId)));
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
      if (filter.status) conds.push(eq(users.status, filter.status));
      if (filter.actorType) conds.push(eq(users.actorType, filter.actorType));
      if (filter.updatedBefore) conds.push(lt(users.updatedAt, filter.updatedBefore));
      const where = coordinator(...conds);

      const rows = await this.selectJoined()
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      const totals = await getDb()
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
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
    if (patch.consent !== undefined) updates['consent'] = patch.consent;
    if (patch.status !== undefined) updates['status'] = patch.status;
    if (patch.rejectedAt !== undefined) updates['rejectedAt'] = patch.rejectedAt;

    let updated: Aggregator | null;
    try {
      updated = await getDb().transaction(async (tx) => {
        if (patch.contact !== undefined) {
          // Lock the row, then move its contact. A re-key is done in place and
          // cascades to the FK, so no contact is left orphaned.
          const [current] = await tx
            .select({ contactId: users.contactId })
            .from(users)
            .where(coordinator(eq(users.id, id)))
            .for('update');
          if (!current) return null;
          const { identity, extra } = splitBecknContact(patch.contact);
          updates['contactId'] = await changeContact(tx, current.contactId, identity);
          updates['contactExtra'] = onlyAlternatePhone(extra);
        }
        const rows = await tx
          .update(users)
          .set(updates)
          .where(coordinator(eq(users.id, id)))
          .returning({ id: users.id });
        return rows.length > 0 ? this.readIn(tx, id) : null;
      });
    } catch (err: unknown) {
      if (err instanceof ContactTakenError) {
        logger.warn({
          operation: 'aggregatorStore.update',
          status: 'failure',
          error: 'CONTACT_TAKEN',
          aggregator_id: id,
        });
        return { ok: false, error: { code: 'DUPLICATE_EMAIL', message: err.message } };
      }
      if (err instanceof SharedContactError) {
        logger.warn({
          operation: 'aggregatorStore.update',
          status: 'failure',
          error: 'SHARED_CONTACT',
          aggregator_id: id,
        });
        return { ok: false, error: { code: 'DUPLICATE', message: err.message } };
      }
      return this.mapWriteError('aggregatorStore.update', err, id, Date.now());
    }
    if (!updated) return { ok: false, error: { code: 'NOT_FOUND', message: id } };
    return { ok: true, value: updated };
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
        .update(users)
        .set({ status: 'active', updatedBy, updatedAt: new Date() })
        .where(coordinator(eq(users.id, id), eq(users.status, 'pending')))
        .returning({ id: users.id });
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
        .update(users)
        .set({
          signalstackOrgId,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(coordinator(eq(users.id, id)))
        .returning({ id: users.id });
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
        .delete(users)
        .where(coordinator(eq(users.id, id)))
        .returning({ id: users.id });
      if (rows.length === 0) {
        return { ok: false, error: { code: 'NOT_FOUND', message: id } };
      }
      return { ok: true, value: undefined };
    } catch (err: unknown) {
      return this.mapReadError('aggregatorStore.deleteById', err);
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * `users` JOIN `contact` LEFT JOIN its org — the one read shape every query
   * uses. `contact_id` is NOT NULL and RESTRICT-protected; the org join is
   * LEFT so a missing org can never hide a coordinator. Every caller filters
   * through {@link coordinator}, so an admin account never reads as an
   * aggregator (the token's `aggregator_id` is resolved here).
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({
        a: users,
        c: contact,
        o: {
          slug: organisations.slug,
          url: organisations.url,
          locations: organisations.locations,
          legalName: organisations.legalName,
          gstNumber: organisations.gstNumber,
        },
      })
      .from(users)
      .innerJoin(contact, eq(contact.id, users.contactId))
      .leftJoin(organisations, eq(organisations.id, users.orgId));
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<Aggregator | null> {
    const [row] = await this.selectJoined(db)
      .where(coordinator(eq(users.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  /** Returns the first row matching `predicate`, or `null`. */
  private async findOne(op: string, predicate: SQL): Promise<StoreResult<Aggregator | null>> {
    try {
      const [row] = await this.selectJoined().where(coordinator(predicate)).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err: unknown) {
      return this.mapReadError(op, err);
    }
  }

  /**
   * Re-reads a row just written by a single-statement update (the joined
   * contact is not in `RETURNING`). A row that vanished in between is
   * reported as `NOT_FOUND`.
   */
  private async reread(op: string, id: string): Promise<StoreResult<Aggregator>> {
    const found = await this.findOne(op, eq(users.id, id));
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
    // which walk Drizzle's `.cause` chain. Gating on the code maps a
    // unique/check violation to a clean 409 rather than a misleading 503.
    // The driver message is never echoed: Drizzle puts the query parameters
    // (emails, phones) in it.
    const code = pgErrorCode(err);
    const constraint = pgConstraint(err) ?? '';
    const message = err instanceof Error ? err.message : '';

    // contactId() rejects a non-canonical phone before any SQL runs — the
    // same class of problem the database CHECK would have reported. Its
    // message is a fixed string, safe to return.
    if (err instanceof TypeError && message.startsWith('contactId:')) {
      logger.warn({
        operation: op,
        status: 'failure',
        error: 'CHECK_VIOLATION',
        latency_ms: Date.now() - start,
      });
      return { ok: false, error: { code: 'CHECK_VIOLATION', message } };
    }

    if (code === PG_UNIQUE_VIOLATION) {
      // Match each constraint explicitly. Defaulting the unknown case to
      // DUPLICATE_SLUG told the user "that name is already taken" for whatever
      // unique index a later migration happens to add (#718 review); the
      // constraint name is logged below either way.
      let storeCode: StoreError['code'] = 'DUPLICATE';
      // The same person already has a coordinator account (one per person per role).
      if (constraint.includes('users_contact_type_unique')) storeCode = 'DUPLICATE_EMAIL';
      else if (constraint.includes('contact_phone')) storeCode = 'DUPLICATE_PHONE';
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
    return this.mapReadError(op, err, start);
  }

  /**
   * Maps any other database failure to `DB_UNAVAILABLE`, logging the SQLSTATE
   * and error class only (never the driver message, which carries parameters).
   */
  private mapReadError(op: string, err: unknown, start?: number): StoreResult<never> {
    const code = pgErrorCode(err);
    const errorType = (err as Error | undefined)?.constructor?.name ?? 'unknown';
    logger.error({
      operation: op,
      status: 'failure',
      error: code ? `database error ${code}` : errorType,
      error_type: errorType,
      sqlstate: code,
      ...(start !== undefined ? { latency_ms: Date.now() - start } : {}),
    });
    return {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: code ? `database error ${code}` : errorType },
    };
  }
}

type JoinedRow = {
  a: typeof users.$inferSelect;
  c: typeof contact.$inferSelect;
  o: {
    slug: string;
    url: string | null;
    locations: (typeof organisations.$inferSelect)['locations'];
    legalName: string | null;
    gstNumber: string | null;
  } | null;
};

/**
 * Builds the Beckn `contact` the API has always returned, from the linked
 * `contact` row, the org's company / GST (rendered) and `contact_extra`. Keys
 * are emitted in the order the legacy jsonb column produced them (Postgres
 * orders jsonb keys by length, then bytes), so a serialised response stays
 * byte-identical.
 */
function composeContact(
  row: JoinedRow,
  company: string | undefined,
  gstNumber: string | undefined,
): BecknContact {
  const { a, c } = row;
  const extra = a.contactExtra ?? {};
  return {
    name: c.name ?? '',
    email: c.email,
    phone: c.phone ?? '',
    ...(company !== undefined ? { company } : {}),
    ...(gstNumber !== undefined ? { gstNumber } : {}),
    ...(extra.alternatePhone !== undefined ? { alternatePhone: extra.alternatePhone } : {}),
  };
}

/**
 * Keeps only `alternatePhone` of a contact's extras: company / GST belong to
 * the org since 0028 and are never stored on the coordinator.
 *
 * @param extra - The extras split off a Beckn contact.
 * @returns The `contact_extra` value to store.
 */
function onlyAlternatePhone(extra: { alternatePhone?: string }): { alternatePhone?: string } {
  return extra.alternatePhone !== undefined ? { alternatePhone: extra.alternatePhone } : {};
}

function toDomain(row: JoinedRow): Aggregator {
  const { a, o } = row;
  const details = renderOrgDetails(o, a.legacyOrgDetails);
  // Legacy `'both'` rows are coerced to null at the boundary — the app no
  // longer treats `both` as a first-class participant focus. Backfill the
  // column to a single value before dropping the DB enum entry.
  const type = a.type === 'both' ? null : a.type;
  const composed = composeContact(row, details.company, details.gstNumber);
  return {
    id: a.id,
    orgSlug: a.orgSlug,
    actorType: a.actorType,
    name: a.name,
    type,
    url: details.url,
    contactId: a.contactId,
    contact: composed,
    contactPhone: composed.phone,
    contactEmail: composed.email,
    locations: details.locations,
    consent: a.consent,
    profile: a.profile ?? {},
    profileRef: a.profileRef,
    status: a.status,
    createdBy: a.createdBy,
    updatedBy: a.updatedBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    signalstackOrgId: a.signalstackOrgId,
    parentOrgId: a.orgId,
    isDefaultOrg: o?.slug === DEFAULT_ORG_SLUG,
    inviteEmail: a.inviteEmail,
    rejectedAt: a.rejectedAt,
  };
}

/**
 * Restricts a filter to coordinator accounts. Every read AND write of this
 * store goes through it: `users` also holds org owners' admin accounts
 * (migration 0027), and an admin id must never resolve as an aggregator — not
 * on a read (the token's `aggregator_id` is looked up here) and not on a write
 * (an admin id yields NOT_FOUND, never a CHECK violation or a deleted account).
 *
 * @param conds - Further conditions (undefined entries are ignored).
 * @returns The combined condition.
 */
function coordinator(...conds: (SQL | undefined)[]): SQL {
  const isCoordinator = eq(users.userType, 'coordinator');
  return and(isCoordinator, ...conds) ?? isCoordinator;
}
