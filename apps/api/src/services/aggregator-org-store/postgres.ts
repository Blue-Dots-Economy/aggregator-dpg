/**
 * Postgres adapter for the aggregator-org store.
 *
 * Wraps Drizzle queries against the `aggregator_orgs` table — the org system
 * of record (spec §5.1). Driver-level errors are normalised to the abstract
 * `OrgStoreError` codes so callers never see raw pg error fields.
 *
 * The owner's email / phone / name live in the `contact` table, referenced by
 * `aggregator_orgs.contact_id` (migrations 0025/0026). The owner's contact is
 * written in the same transaction as the org row (`db/contact-writes.ts`), and
 * every write re-reads the joined row inside that transaction, because
 * `RETURNING` cannot include the joined contact. Keycloak keeps its own copy of
 * the owner's login identifiers.
 */

import { and, eq, lt, sql, type SQL } from 'drizzle-orm';
import { aggregatorOrgs, contact } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, pgConstraint } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import { linkContact, type DbExecutor } from '../../db/contact-writes.js';
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
        // The owner's contact and the org row are written atomically.
        const contactId = await linkContact(tx, {
          email: input.ownerEmail,
          phone: input.ownerPhone ?? null,
          name: input.ownerName ?? null,
        });
        const [row] = await tx
          .insert(aggregatorOrgs)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            state: input.state ?? null,
            contactId,
            ownerKcSub: input.ownerKcSub ?? null,
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
    // `contact_id = (subselect)` keeps the lookup on contact_email_unique +
    // aggregator_orgs_contact_id_idx.
    return this.findOne(
      eq(
        aggregatorOrgs.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.email} = ${e})`,
      ),
    );
  }

  async findByOwnerPhone(phone: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    // Every org row holds its owner's phone through `contact_phone_unique`, so
    // the lookup matches the constraint exactly (a half-created org is deleted
    // by the create route, never left behind).
    return this.findOne(
      eq(
        aggregatorOrgs.contactId,
        sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.phone} = ${phone})`,
      ),
    );
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
    try {
      const updated = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(aggregatorOrgs)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(aggregatorOrgs.id, id))
          .returning({ id: aggregatorOrgs.id });
        if (rows.length === 0) return null;
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
   * `aggregator_orgs` JOIN `contact` — the one read shape every query uses.
   * An inner join: `contact_id` is NOT NULL (0026) and RESTRICT-protected.
   *
   * @param db - Executor (the pool, or the caller's transaction).
   */
  private selectJoined(db: DbExecutor = getDb()) {
    return db
      .select({ o: aggregatorOrgs, c: contact })
      .from(aggregatorOrgs)
      .innerJoin(contact, eq(contact.id, aggregatorOrgs.contactId));
  }

  /** Reads one joined row through `db` (used inside write transactions). */
  private async readIn(db: DbExecutor, id: string): Promise<AggregatorOrg | null> {
    const [row] = await this.selectJoined(db).where(eq(aggregatorOrgs.id, id)).limit(1);
    return row ? toDomain(row) : null;
  }

  private async findOne(predicate: SQL): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await this.selectJoined().where(predicate).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return mapDbError('orgStore.findOne', e);
    }
  }
}

type JoinedRow = {
  o: typeof aggregatorOrgs.$inferSelect;
  c: typeof contact.$inferSelect;
};

function toDomain(row: JoinedRow): AggregatorOrg {
  const { o, c } = row;
  return {
    id: o.id,
    slug: o.slug,
    displayName: o.displayName,
    state: o.state,
    contactId: o.contactId,
    ownerEmail: c.email,
    ownerPhone: c.phone,
    ownerName: c.name,
    ownerKcSub: o.ownerKcSub,
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
