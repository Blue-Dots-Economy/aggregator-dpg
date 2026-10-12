/**
 * Postgres adapter for the aggregator-org store.
 *
 * Wraps Drizzle queries against the `organisations` table (was
 * `aggregator_orgs`, migration 0028) — the org system of record (spec §5.1).
 * Every query is scoped to `org_type = 'aggregator'` ({@link scoped}) except
 * `findRoot`, so the network-facilitator root never reaches a caller. Driver-level errors are normalised to the abstract
 * `OrgStoreError` codes so callers never see raw pg error fields.
 *
 * The owner is an `admin` account in `users` (`aggregator_orgs.owner_user_id`,
 * migration 0027); its email / phone / name live in `contact` and its IdP login
 * in `user_identities`. The owner's contact and account are written in the
 * same transaction as the org row (`db/contact-writes.ts`,
 * `db/account-writes.ts`), and every write re-reads the joined row inside that
 * transaction, because `RETURNING` cannot include the joined owner. Deleting an
 * org releases the owner's account in the database (`organisations_owner_ad`)
 * once it owns no other org.
 */

import { and, asc, desc, eq, lt, ne, sql, type SQL } from 'drizzle-orm';
import { organisations, contact, userIdentities, users } from '../../db/schema.js';
import type { BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
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
  DEFAULT_ORG_SLUG,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

/** Wraps a failure of the caller's `recordConsent` hook so `create` can tell it apart. */
class ConsentHookError extends Error {
  constructor(cause: unknown) {
    super('recordConsent failed', { cause });
    this.name = 'ConsentHookError';
  }
}

export class PostgresAggregatorOrgStore extends AggregatorOrgStoreBase {
  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    const start = Date.now();
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
        // Every aggregator org sits under the network-facilitator root (0028).
        const [root] = await tx
          .select({ id: organisations.id })
          .from(organisations)
          .where(eq(organisations.orgType, 'network_facilitator'))
          .limit(1);
        if (!root) throw new Error('network-facilitator root missing');
        const [row] = await tx
          .insert(organisations)
          .values({
            slug: input.slug,
            name: input.displayName,
            orgType: 'aggregator',
            parentId: root.id,
            state: input.state ?? null,
            orgOwner: ownerUserId,
            kcGroupId: input.kcGroupId ?? null,
            url: input.url ?? null,
            locations: input.locations ?? [],
            profile: input.profile ?? {},
            profileRef: input.profileRef ?? null,
            createdBy: 'self',
            updatedBy: 'self',
          })
          .returning({ id: organisations.id });
        if (!row) throw new Error('insert returned no row');
        // The consent row commits with the org, or neither does (0029).
        if (input.recordConsent) {
          try {
            await input.recordConsent(tx, row.id);
          } catch (hookErr: unknown) {
            throw new ConsentHookError(hookErr);
          }
        }
        return this.readIn(tx, row.id);
      });
      if (!created) return errResult('DB_UNAVAILABLE', 'org row not readable after insert');
      return { ok: true, value: created };
    } catch (e) {
      if (e instanceof ConsentHookError) {
        logger.error({
          operation: 'orgStore.create',
          status: 'failure',
          error: 'CONSENT_WRITE_FAILED',
          error_type: (e.cause as Error | undefined)?.name ?? 'unknown',
          latency_ms: Date.now() - start,
        });
        return errResult('CONSENT_WRITE_FAILED', 'consent could not be recorded');
      }
      return mapDbError('orgStore.create', e);
    }
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(organisations.id, id));
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(organisations.slug, slug));
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const e = email.trim().toLowerCase();
    // The owner's admin account by its contact's email (contact_email_unique),
    // then its orgs. One owner may own several orgs (a rejected one and a new
    // one), so the pick is deterministic: live first, then newest. The Default
    // org is skipped: the network admin owns it, and must not read as an owner.
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
          SELECT o.org_owner, u.contact_id
            FROM ${organisations} o JOIN ${users} u ON u.id = o.org_owner
           WHERE o.id = ${id})
        SELECT EXISTS (
                 SELECT 1 FROM ${organisations} other, me
                  WHERE other.org_owner = me.org_owner AND other.id <> ${id})
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
      const rows = await this.selectJoined()
        .where(scoped(eq(organisations.status, 'active')))
        .orderBy(sql`lower(${organisations.name})`);
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listActive', e);
    }
  }

  async listPending(updatedBefore?: Date): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const where = updatedBefore
        ? and(eq(organisations.status, 'pending'), lt(organisations.updatedAt, updatedBefore))
        : eq(organisations.status, 'pending');
      const rows = await this.selectJoined().where(scoped(where));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return mapDbError('orgStore.listPending', e);
    }
  }

  async findDefault(): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(organisations.slug, DEFAULT_ORG_SLUG));
  }

  async findRoot(): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await this.selectJoined()
        .where(eq(organisations.orgType, 'network_facilitator'))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return mapDbError('orgStore.findRoot', e);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    // The owner's IdP login lives on the owner's account, not the org row.
    const { ownerKcSub, displayName, ...rest } = patch;
    const columns = displayName === undefined ? rest : { ...rest, name: displayName };
    try {
      const updated = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(organisations)
          .set({ ...columns, updatedAt: new Date() })
          .where(scoped(eq(organisations.id, id)))
          .returning({ id: organisations.id, orgOwner: organisations.orgOwner });
        const [row] = rows;
        if (!row) return null;
        // A null subject never unlinks: a recorded login is only ever added.
        if (ownerKcSub) await linkIdentity(tx, row.orgOwner, IDP_PROVIDER, ownerKcSub, 'admin');
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
      // Never the root or the Default org: they are not removable here.
      await getDb()
        .delete(organisations)
        .where(scoped(and(eq(organisations.id, id), ne(organisations.slug, DEFAULT_ORG_SLUG))));
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
        .update(organisations)
        // Stamp rejected_at (write-once) on the reject transition only (#726).
        .set({
          status: next,
          updatedAt: new Date(),
          ...(next === 'inactive' ? { rejectedAt: new Date() } : {}),
        })
        .where(scoped(and(eq(organisations.id, id), eq(organisations.status, 'pending'))))
        .returning({ id: organisations.id });
      if (!row) return { ok: true, value: null };
    } catch (e) {
      return mapDbError('orgStore.casFromPending', e);
    }
    return this.findOne(eq(organisations.id, id));
  }

  /**
   * `organisations` JOIN the owner's admin account JOIN its `contact`, LEFT
   * JOIN its IdP login — the one read shape every query uses. The inner joins
   * hold: `org_owner` is NOT NULL and RESTRICT-protected (0027/0028).
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({ o: organisations, c: contact, ownerKcSub: userIdentities.subject })
      .from(organisations)
      .innerJoin(users, eq(users.id, organisations.orgOwner))
      .innerJoin(contact, eq(contact.id, users.contactId))
      .leftJoin(
        userIdentities,
        and(eq(userIdentities.userId, users.id), eq(userIdentities.provider, IDP_PROVIDER)),
      );
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<AggregatorOrg | null> {
    const [row] = await this.selectJoined(db)
      .where(scoped(eq(organisations.id, id)))
      .limit(1);
    return row ? toDomain(row) : null;
  }

  /**
   * Reads at most one org.
   *
   * @param predicate - The filter.
   * @param byOwner - When true the filter matches an OWNER (who may own several
   *   orgs): restrict to admin owners, skip the Default org, and order
   *   live-first, then newest.
   */
  private async findOne(
    predicate: SQL,
    byOwner = false,
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const q = this.selectJoined().where(
        scoped(
          byOwner
            ? and(predicate, eq(users.userType, 'admin'), ne(organisations.slug, DEFAULT_ORG_SLUG))!
            : predicate,
        ),
      );
      const [row] = await (byOwner
        ? q
            .orderBy(
              asc(sql`CASE WHEN ${organisations.status} IN ('pending','active') THEN 0 ELSE 1 END`),
              desc(organisations.createdAt),
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
  o: typeof organisations.$inferSelect;
  c: typeof contact.$inferSelect;
  ownerKcSub: string | null;
};

function toDomain(row: JoinedRow): AggregatorOrg {
  const { o, c } = row;
  return {
    id: o.id,
    slug: o.slug,
    displayName: o.name,
    state: o.state,
    contactId: c.id,
    ownerUserId: o.orgOwner,
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
    isDefault: o.orgType === 'aggregator' && o.slug === DEFAULT_ORG_SLUG,
    url: o.url,
    locations: (o.locations ?? []) as BecknLocation[],
    legalName: o.legalName,
    gstNumber: o.gstNumber,
  };
}

/**
 * Restricts a predicate to `aggregator` orgs — every read and write of this
 * store goes through it, so the network-facilitator root is never returned or
 * modified here.
 *
 * @param predicate - The caller's filter.
 * @returns The scoped filter.
 */
function scoped(predicate: SQL | undefined): SQL {
  return and(eq(organisations.orgType, 'aggregator'), predicate)!;
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
    if (constraint.includes('organisations_name_live_unique')) {
      return err('DUPLICATE_NAME', 'organisation name already in use');
    }
    if (constraint.includes('organisations_slug_live_unique')) {
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
