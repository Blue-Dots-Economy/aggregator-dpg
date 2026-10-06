/**
 * Postgres adapter for the aggregator-org store.
 *
 * Wraps Drizzle queries against the `aggregator_orgs` table — the org system
 * of record (spec §5.1). Driver-level errors are normalised to the abstract
 * `OrgStoreError` codes so callers never see raw pg error fields.
 *
 * The owner is an `admin` account in `users` (`aggregator_orgs.owner_user_id`,
 * migration 0027); its email / phone / name live in `contact` and its IdP login
 * in `user_identities`. The owner's contact and account are written in the
 * same transaction as the org row (`db/contact-writes.ts`,
 * `db/account-writes.ts`), and every write re-reads the joined row inside that
 * transaction, because `RETURNING` cannot include the joined owner. Deleting an
 * org releases the owner's account in the database (`aggregator_orgs_owner_ad`)
 * once it owns no other org.
 */

import { and, asc, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { aggregatorOrgs, contact, userIdentities, users } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, pgConstraint } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import { linkContact, type DbExecutor } from '../../db/contact-writes.js';
import {
  IdentityMismatchError,
  IdentityTakenError,
  linkAdminAccount,
  linkIdentity,
} from '../../db/account-writes.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import {
  AggregatorOrgStoreBase,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

export class PostgresAggregatorOrgStore extends AggregatorOrgStoreBase {
  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    try {
      const created = await getDb().transaction(async (tx) => {
        // The owner's contact, the owner's admin account and the org row are
        // written atomically.
        const contactId = await linkContact(tx, {
          email: input.ownerEmail,
          phone: input.ownerPhone ?? null,
          name: input.ownerName ?? null,
        });
        const ownerUserId = await linkAdminAccount(tx, contactId);
        if (input.ownerKcSub)
          await linkIdentity(tx, ownerUserId, IDP_PROVIDER, input.ownerKcSub, 'admin');
        const [row] = await tx
          .insert(aggregatorOrgs)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            state: input.state ?? null,
            ownerUserId,
            kcGroupId: input.kcGroupId ?? null,
            profile: input.profile ?? {},
            profileRef: input.profileRef ?? null,
          })
          .returning({ id: aggregatorOrgs.id });
        if (!row) throw new Error('insert returned no row');
        return this.readIn(tx, row.id);
      });
      if (!created) return errResult('DB_UNAVAILABLE', 'org row not readable after insert');
      return { ok: true, value: created };
    } catch (e) {
      return mapDbError('orgStore.create', e);
    }
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.id, id));
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.slug, slug));
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const e = email.trim().toLowerCase();
    // The owner's admin account by its contact's email (contact_email_unique),
    // then its orgs. One owner may own several orgs (a rejected one and a new
    // one), so the pick is deterministic: live first, then newest.
    return this.findOne(eq(contact.email, e), true);
  }

  async findByOwnerPhone(phone: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    // Same shape as findByOwnerEmail, keyed on contact_phone_unique.
    return this.findOne(eq(contact.phone, phone), true);
  }

  async ownerIsShared(id: string): Promise<OrgStoreResult<boolean>> {
    try {
      // Shared when the owner's account owns another org, OR the same person
      // also has a coordinator account (one IdP user per person: deleting it
      // would lock the coordinator out).
      const rows = await getDb().execute<{ shared: boolean }>(sql`
        WITH me AS (
          SELECT o.owner_user_id, u.contact_id
            FROM ${aggregatorOrgs} o JOIN ${users} u ON u.id = o.owner_user_id
           WHERE o.id = ${id})
        SELECT EXISTS (
                 SELECT 1 FROM ${aggregatorOrgs} other, me
                  WHERE other.owner_user_id = me.owner_user_id AND other.id <> ${id})
            OR EXISTS (
                 SELECT 1 FROM ${users} c, me
                  WHERE c.contact_id = me.contact_id AND c.user_type = 'coordinator') AS shared`);
      return { ok: true, value: Boolean(rows.rows[0]?.shared) };
    } catch (e) {
      return mapDbError('orgStore.ownerIsShared', e);
    }
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const rows = await this.selectJoined().where(eq(aggregatorOrgs.status, 'active'));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listActive', e);
    }
  }

  async listPending(updatedBefore?: Date): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const where = updatedBefore
        ? and(eq(aggregatorOrgs.status, 'pending'), lt(aggregatorOrgs.updatedAt, updatedBefore))
        : eq(aggregatorOrgs.status, 'pending');
      const rows = await this.selectJoined().where(where);
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listPending', e);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    // The owner's IdP login lives on the owner's account, not the org row.
    const { ownerKcSub, ...columns } = patch;
    try {
      const updated = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(aggregatorOrgs)
          .set({ ...columns, updatedAt: new Date() })
          .where(eq(aggregatorOrgs.id, id))
          .returning({ id: aggregatorOrgs.id, ownerUserId: aggregatorOrgs.ownerUserId });
        const [row] = rows;
        if (!row) return null;
        // A null subject never unlinks: a recorded login is only ever added.
        if (ownerKcSub) await linkIdentity(tx, row.ownerUserId, IDP_PROVIDER, ownerKcSub, 'admin');
        return this.readIn(tx, id);
      });
      if (!updated) return errResult('NOT_FOUND', id);
      return { ok: true, value: updated };
    } catch (e) {
      return mapDbError('orgStore.update', e);
    }
  }

  async deleteById(id: string): Promise<OrgStoreResult<void>> {
    try {
      await getDb().delete(aggregatorOrgs).where(eq(aggregatorOrgs.id, id));
      return { ok: true, value: undefined };
    } catch (e) {
      return mapDbError('orgStore.deleteById', e);
    }
  }

  async approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active');
  }

  async reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive');
  }

  private async casFromPending(
    id: string,
    next: 'active' | 'inactive',
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await getDb()
        .update(aggregatorOrgs)
        // Stamp rejected_at (write-once) on the reject transition only (#726).
        .set({
          status: next,
          updatedAt: new Date(),
          ...(next === 'inactive' ? { rejectedAt: new Date() } : {}),
        })
        .where(and(eq(aggregatorOrgs.id, id), eq(aggregatorOrgs.status, 'pending')))
        .returning({ id: aggregatorOrgs.id });
      if (!row) return { ok: true, value: null };
    } catch (e) {
      return mapDbError('orgStore.casFromPending', e);
    }
    return this.findOne(eq(aggregatorOrgs.id, id));
  }

  /**
   * `aggregator_orgs` JOIN the owner's admin account JOIN its `contact`, LEFT
   * JOIN its IdP login — the one read shape every query uses. The inner joins
   * hold: `owner_user_id` is NOT NULL and RESTRICT-protected (0027).
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({ o: aggregatorOrgs, c: contact, ownerKcSub: userIdentities.subject })
      .from(aggregatorOrgs)
      .innerJoin(users, eq(users.id, aggregatorOrgs.ownerUserId))
      .innerJoin(contact, eq(contact.id, users.contactId))
      .leftJoin(
        userIdentities,
        and(eq(userIdentities.userId, users.id), eq(userIdentities.provider, IDP_PROVIDER)),
      );
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<AggregatorOrg | null> {
    const [row] = await this.selectJoined(db).where(eq(aggregatorOrgs.id, id)).limit(1);
    return row ? toDomain(row) : null;
  }

  /**
   * Reads at most one org.
   *
   * @param predicate - The filter.
   * @param byOwner - When true the filter matches an OWNER (who may own several
   *   orgs): restrict to admin owners and order live-first, then newest.
   */
  private async findOne(
    predicate: SQL,
    byOwner = false,
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const q = this.selectJoined().where(
        byOwner ? and(predicate, eq(users.userType, 'admin')) : predicate,
      );
      const [row] = await (byOwner
        ? q
            .orderBy(
              asc(
                sql`CASE WHEN ${aggregatorOrgs.status} IN ('pending','active') THEN 0 ELSE 1 END`,
              ),
              desc(aggregatorOrgs.createdAt),
            )
            .limit(1)
        : q.limit(1));
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return mapDbError('orgStore.findOne', e);
    }
  }
}

type JoinedRow = {
  o: typeof aggregatorOrgs.$inferSelect;
  c: typeof contact.$inferSelect;
  ownerKcSub: string | null;
};

function toDomain(row: JoinedRow): AggregatorOrg {
  const { o, c } = row;
  return {
    id: o.id,
    slug: o.slug,
    displayName: o.displayName,
    state: o.state,
    contactId: c.id,
    ownerUserId: o.ownerUserId,
    ownerEmail: c.email,
    ownerPhone: c.phone,
    ownerName: c.name,
    ownerKcSub: row.ownerKcSub,
    kcGroupId: o.kcGroupId,
    profile: o.profile ?? {},
    profileRef: o.profileRef,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    rejectedAt: o.rejectedAt,
  };
}

/**
 * Maps a database failure to an `OrgStoreError` and logs it (SQLSTATE and
 * constraint name only — never the driver message, which carries parameters).
 *
 * @param op - Operation name for the log entry.
 * @param e - The thrown error.
 * @returns The failure result.
 */
function mapDbError(op: string, e: unknown): OrgStoreResult<never> {
  if (e instanceof IdentityTakenError || e instanceof IdentityMismatchError) {
    // The owner's IdP login conflicts with a recorded one: never overwritten.
    logger.warn({ operation: op, status: 'failure', error: 'identity_conflict', reason: e.name });
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'owner login conflict' } };
  }
  const code = pgErrorCode(e);
  const constraint = pgConstraint(e) ?? '';
  const error = classifyWriteError(e, code, constraint);
  logger.warn({
    operation: op,
    status: 'failure',
    error: error.code,
    sqlstate: code,
    constraint: constraint || undefined,
  });
  return { ok: false, error };
}

function classifyWriteError(
  e: unknown,
  code: string | undefined,
  constraint: string,
): OrgStoreError {
  // Only a genuine unique-violation (SQLSTATE 23505) maps to a 409 — gate on the
  // code first so a connection failure on a query that happens to mention a
  // constraint name isn't misreported as a duplicate.
  if (code === PG_UNIQUE_VIOLATION) {
    if (constraint.includes('aggregator_orgs_display_name_active_unique')) {
      return err('DUPLICATE_NAME', 'organisation name already in use');
    }
    if (constraint.includes('aggregator_orgs_slug_active_unique')) {
      return err('DUPLICATE_SLUG', 'slug already in use');
    }
    if (constraint.includes('contact_email_unique')) {
      return err('DUPLICATE_EMAIL', 'owner email already belongs to another person');
    }
    if (constraint.includes('contact_phone_unique')) {
      return err('DUPLICATE_PHONE', 'owner phone already belongs to another person');
    }
  }
  // Never echo the driver message: Drizzle includes the query parameters in it.
  return err('DB_UNAVAILABLE', code ? `database error ${code}` : (e as Error).name);
}

function err(code: OrgStoreError['code'], message: string): OrgStoreError {
  return { code, message } as OrgStoreError;
}

function errResult<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: err(code, message) };
}
