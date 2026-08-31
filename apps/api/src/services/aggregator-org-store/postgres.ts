/**
 * Postgres adapter for the aggregator-org store.
 *
 * Wraps Drizzle queries against the `aggregator_orgs` table — the org system
 * of record (spec §5.1). Driver-level errors are normalised to the abstract
 * `OrgStoreError` codes so callers never see raw pg error fields. PII
 * (owner_email) is an ordinary indexed column here; Keycloak remains
 * authoritative for the owner identity.
 */

import { and, eq, lt, type SQL } from 'drizzle-orm';
import { aggregatorOrgs } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
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
      const [row] = await getDb()
        .insert(aggregatorOrgs)
        .values({
          slug: input.slug,
          displayName: input.displayName,
          state: input.state ?? null,
          ownerEmail: input.ownerEmail.toLowerCase(),
          ownerPhone: input.ownerPhone ?? null,
          ownerKcSub: input.ownerKcSub ?? null,
          kcGroupId: input.kcGroupId ?? null,
          profile: input.profile ?? {},
          profileRef: input.profileRef ?? null,
        })
        .returning();
      if (!row) return errResult('DB_UNAVAILABLE', 'insert returned no row');
      return { ok: true, value: toDomain(row) };
    } catch (e) {
      return mapInsertError(e);
    }
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.id, id));
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.slug, slug));
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.ownerEmail, email.toLowerCase()));
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(aggregatorOrgs)
        .where(eq(aggregatorOrgs.status, 'active'));
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
      const rows = await getDb().select().from(aggregatorOrgs).where(where);
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    try {
      const [row] = await getDb()
        .update(aggregatorOrgs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(aggregatorOrgs.id, id))
        .returning();
      if (!row) return errResult('NOT_FOUND', id);
      return { ok: true, value: toDomain(row) };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
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
        .set({ status: next, updatedAt: new Date() })
        .where(and(eq(aggregatorOrgs.id, id), eq(aggregatorOrgs.status, 'pending')))
        .returning();
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  private async findOne(predicate: SQL): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await getDb().select().from(aggregatorOrgs).where(predicate).limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }
}

function toDomain(row: typeof aggregatorOrgs.$inferSelect): AggregatorOrg {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    state: row.state,
    ownerEmail: row.ownerEmail,
    ownerPhone: row.ownerPhone,
    ownerKcSub: row.ownerKcSub,
    kcGroupId: row.kcGroupId,
    profile: row.profile ?? {},
    profileRef: row.profileRef,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapInsertError(e: unknown): OrgStoreResult<never> {
  // Drizzle wraps the driver error: its own `.message` is the query text
  // ("Failed query: insert into …"), NOT the Postgres detail. The constraint
  // name + SQLSTATE (23505 = unique_violation) live on the wrapped `.cause`
  // (the `pg` driver error). Inspect both so a unique violation maps to a
  // clean 409 (DUPLICATE_NAME/SLUG) instead of a misleading 503 DB_UNAVAILABLE.
  const cause = (e as { cause?: unknown }).cause;
  const constraint =
    typeof cause === 'object' && cause !== null && 'constraint' in cause
      ? String((cause as { constraint?: unknown }).constraint ?? '')
      : '';
  const text = `${(e as Error).message ?? ''} ${(cause as Error | undefined)?.message ?? ''} ${constraint}`;
  if (text.includes('aggregator_orgs_display_name_active_unique')) {
    return errResult('DUPLICATE_NAME', 'organisation name already in use');
  }
  if (text.includes('aggregator_orgs_slug_active_unique')) {
    return errResult('DUPLICATE_SLUG', 'slug already in use');
  }
  return errResult('DB_UNAVAILABLE', (e as Error).message ?? 'insert failed');
}

function errResult<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
