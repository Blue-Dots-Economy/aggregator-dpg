/**
 * Postgres adapter for the aggregator-org store.
 *
 * Wraps Drizzle queries against the `aggregator_orgs` table — the org system
 * of record (spec §5.1). Driver-level errors are normalised to the abstract
 * `OrgStoreError` codes so callers never see raw pg error fields.
 *
 * The owner's email / phone / name are read from the `contact` table through
 * `aggregator_orgs.contact_id` (migration 0025). Writes go to `contact`
 * directly in the same transaction (`db/contact-writes.ts`); the legacy
 * `owner_email` / `owner_phone` columns are written as NULL and dropped in the
 * next release. Every write re-reads the joined row. Keycloak keeps its own copy of the
 * owner's login identifiers.
 */

import { and, eq, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { aggregatorOrgs, contact } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, pgConstraint } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import {
  changeContact,
  ContactTakenError,
  gcContact,
  linkContact,
  SharedContactError,
} from '../../db/contact-writes.js';
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
    let id: string;
    try {
      id = await getDb().transaction(async (tx) => {
        // The owner's contact and the org row are written atomically; the
        // legacy owner_email / owner_phone columns are left NULL (dropped in
        // the next release).
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
        return row.id;
      });
    } catch (e) {
      return mapInsertError(e);
    }
    return this.reread(id);
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
    // Excludes the half-created rows a failed org create leaves behind
    // (inactive, no Keycloak owner) — those never became anyone's login, so
    // they must not block a retry.
    return this.findOne(
      and(
        eq(
          aggregatorOrgs.contactId,
          sql`(SELECT ${contact.id} FROM ${contact} WHERE ${contact.phone} = ${phone})`,
        ),
        or(ne(aggregatorOrgs.status, 'inactive'), isNotNull(aggregatorOrgs.ownerKcSub)),
      )!,
    );
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const rows = await this.selectJoined().where(eq(aggregatorOrgs.status, 'active'));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
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
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    const { ownerPhone, ...rest } = patch;
    try {
      const found = await getDb().transaction(async (tx) => {
        const set: Record<string, unknown> = { ...rest, updatedAt: new Date() };
        if (ownerPhone !== undefined) {
          // The phone lives on the owner's contact: move it (plan §3.3).
          const [current] = await tx
            .select({ o: aggregatorOrgs, c: contact })
            .from(aggregatorOrgs)
            .leftJoin(contact, eq(contact.id, aggregatorOrgs.contactId))
            .where(eq(aggregatorOrgs.id, id))
            .for('update', { of: aggregatorOrgs });
          if (!current) return false;
          const email = current.c?.email;
          if (!email) throw new Error('org has no owner contact to re-key');
          const nextId = await changeContact(tx, current.o.contactId, {
            email,
            phone: ownerPhone,
            name: null,
          });
          set['contactId'] = nextId;
          const rows = await tx
            .update(aggregatorOrgs)
            .set(set)
            .where(eq(aggregatorOrgs.id, id))
            .returning({ id: aggregatorOrgs.id });
          if (current.o.contactId && current.o.contactId !== nextId) {
            await gcContact(tx, current.o.contactId);
          }
          return rows.length > 0;
        }
        const rows = await tx
          .update(aggregatorOrgs)
          .set(set)
          .where(eq(aggregatorOrgs.id, id))
          .returning({ id: aggregatorOrgs.id });
        return rows.length > 0;
      });
      if (!found) return errResult('NOT_FOUND', id);
    } catch (e) {
      return mapInsertError(e);
    }
    return this.reread(id);
  }

  async deleteById(id: string): Promise<OrgStoreResult<void>> {
    try {
      await getDb().delete(aggregatorOrgs).where(eq(aggregatorOrgs.id, id));
      return { ok: true, value: undefined };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
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
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
    return this.findOne(eq(aggregatorOrgs.id, id));
  }

  /** `aggregator_orgs` LEFT JOIN `contact` — the one read shape every query uses. */
  private selectJoined() {
    return getDb()
      .select({ o: aggregatorOrgs, c: contact })
      .from(aggregatorOrgs)
      .leftJoin(contact, eq(contact.id, aggregatorOrgs.contactId));
  }

  private async findOne(predicate: SQL): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await this.selectJoined().where(predicate).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  /** Re-reads a row just written so the result reflects the contact sync triggers. */
  private async reread(id: string): Promise<OrgStoreResult<AggregatorOrg>> {
    const found = await this.findOne(eq(aggregatorOrgs.id, id));
    if (!found.ok) return found;
    if (!found.value) return errResult('NOT_FOUND', id);
    return { ok: true, value: found.value };
  }
}

type JoinedRow = {
  o: typeof aggregatorOrgs.$inferSelect;
  c: typeof contact.$inferSelect | null;
};

function toDomain(row: JoinedRow): AggregatorOrg {
  const { o, c } = row;
  if (!c) {
    logger.warn({
      operation: 'orgStore.toDomain',
      status: 'failure',
      error: 'org has no linked owner contact',
      org_id: o.id,
    });
  }
  return {
    id: o.id,
    slug: o.slug,
    displayName: o.displayName,
    state: o.state,
    contactId: o.contactId,
    ownerEmail: c?.email ?? '',
    ownerPhone: c?.phone ?? null,
    ownerName: c ? c.name : null,
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

function mapInsertError(e: unknown): OrgStoreResult<never> {
  // Only a genuine unique-violation (SQLSTATE 23505) maps to a 409 — gate on the
  // code first so a connection failure on a query that happens to mention a
  // constraint name isn't misreported as a duplicate. The constraint name lives
  // on the wrapped `.cause`; both come from the shared pg-error helpers.
  if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) {
    const constraint = pgConstraint(e) ?? '';
    if (constraint.includes('aggregator_orgs_display_name_active_unique')) {
      return errResult('DUPLICATE_NAME', 'organisation name already in use');
    }
    if (constraint.includes('aggregator_orgs_slug_active_unique')) {
      return errResult('DUPLICATE_SLUG', 'slug already in use');
    }
    if (constraint.includes('contact_email_unique') || constraint === 'contact_pkey') {
      return errResult('DUPLICATE_EMAIL', 'owner email already belongs to another person');
    }
    if (constraint.includes('contact_phone_unique')) {
      return errResult('DUPLICATE_PHONE', 'owner phone already belongs to another person');
    }
  }
  if (e instanceof ContactTakenError || e instanceof SharedContactError) {
    return errResult('DUPLICATE_EMAIL', e.message);
  }
  return errResult('DB_UNAVAILABLE', (e as Error).message ?? 'insert failed');
}

function errResult<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
