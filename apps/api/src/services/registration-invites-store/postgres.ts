/**
 * Postgres registration-invites store (`@aggregator-dpg/api`).
 *
 * Queries `registration_invites` and maps driver errors to `InviteStoreError`
 * codes. The unique index on pending (org_id, role, email) surfaces as
 * `DUPLICATE_PENDING`.
 */

import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { registrationInvites, type RegistrationInviteRow } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/pg-error.js';
import {
  RegistrationInvitesStoreBase,
  type CreateInviteInput,
  type InviteRole,
  type ListOpenInvitesInput,
  type InviteStoreResult,
  type RefreshInviteInput,
  type RegistrationInvite,
} from './interface.js';

function toDomain(row: RegistrationInviteRow): RegistrationInvite {
  return {
    jti: row.jti,
    role: row.role,
    parentOrgId: row.orgId,
    email: row.email,
    status: row.status,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
  };
}

export class PostgresRegistrationInvitesStore extends RegistrationInvitesStoreBase {
  async create(input: CreateInviteInput): Promise<InviteStoreResult<RegistrationInvite>> {
    const start = Date.now();
    try {
      const rows = await getDb()
        .insert(registrationInvites)
        .values({
          orgId: input.parentOrgId,
          email: input.email,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          role: input.role ?? 'coordinator',
        })
        .returning();
      const row = rows[0];
      if (!row) return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'no row returned' } };
      return { ok: true, value: toDomain(row) };
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        return {
          ok: false,
          error: { code: 'DUPLICATE_PENDING', message: 'a live invite already exists' },
        };
      }
      return this.mapDbError('inviteStore.create', err, start);
    }
  }

  async findByJti(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(registrationInvites)
        .where(eq(registrationInvites.jti, jti))
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err) {
      return this.mapDbError('inviteStore.findByJti', err, Date.now());
    }
  }

  async findPendingByOrgAndEmail(
    parentOrgId: string,
    role: InviteRole,
    email: string,
  ): Promise<InviteStoreResult<RegistrationInvite | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(registrationInvites)
        .where(
          and(
            eq(registrationInvites.orgId, parentOrgId),
            eq(registrationInvites.role, role),
            eq(registrationInvites.email, email),
            eq(registrationInvites.status, 'pending'),
          ),
        )
        .limit(1);
      return { ok: true, value: row ? toDomain(row) : null };
    } catch (err) {
      return this.mapDbError('inviteStore.findPendingByOrgAndEmail', err, Date.now());
    }
  }

  async listOpen(input: ListOpenInvitesInput): Promise<InviteStoreResult<RegistrationInvite[]>> {
    const start = Date.now();
    try {
      const { after } = input;
      const createdMs = sql`date_trunc('milliseconds', ${registrationInvites.createdAt})`;
      const rows = await getDb()
        .select()
        .from(registrationInvites)
        .where(
          and(
            eq(registrationInvites.orgId, input.orgId),
            eq(registrationInvites.role, input.role),
            inArray(registrationInvites.status, ['pending', 'expired']),
            after
              ? or(
                  lt(createdMs, after.createdAt),
                  and(eq(createdMs, after.createdAt), lt(registrationInvites.jti, after.jti)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(createdMs), desc(registrationInvites.jti))
        .limit(input.limit);
      return { ok: true, value: rows.map(toDomain) };
    } catch (err) {
      return this.mapDbError('inviteStore.listOpen', err, start);
    }
  }

  async refresh(
    jti: string,
    input: RefreshInviteInput,
  ): Promise<InviteStoreResult<RegistrationInvite>> {
    try {
      const rows = await getDb()
        .update(registrationInvites)
        .set({ expiresAt: input.expiresAt, createdBy: input.createdBy })
        .where(and(eq(registrationInvites.jti, jti), eq(registrationInvites.status, 'pending')))
        .returning();
      const row = rows[0];
      if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: jti } };
      return { ok: true, value: toDomain(row) };
    } catch (err) {
      return this.mapDbError('inviteStore.refresh', err, Date.now());
    }
  }

  async consume(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    return this.casTerminal('inviteStore.consume', jti, 'consumed', true);
  }

  async revoke(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    return this.casTerminal('inviteStore.revoke', jti, 'revoked', false);
  }

  async release(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>> {
    try {
      const rows = await getDb()
        .update(registrationInvites)
        .set({ status: 'pending', consumedAt: null })
        .where(and(eq(registrationInvites.jti, jti), eq(registrationInvites.status, 'consumed')))
        .returning();
      return { ok: true, value: rows[0] ? toDomain(rows[0]) : null };
    } catch (err) {
      return this.mapDbError('inviteStore.release', err, Date.now());
    }
  }

  /**
   * Atomically moves a pending invite to `next`; used by consume and revoke.
   *
   * Returns `null` when the invite was not pending.
   */
  private async casTerminal(
    op: string,
    jti: string,
    next: 'consumed' | 'revoked',
    stampConsumedAt: boolean,
  ): Promise<InviteStoreResult<RegistrationInvite | null>> {
    try {
      const rows = await getDb()
        .update(registrationInvites)
        .set({ status: next, ...(stampConsumedAt ? { consumedAt: new Date() } : {}) })
        .where(and(eq(registrationInvites.jti, jti), eq(registrationInvites.status, 'pending')))
        .returning();
      return { ok: true, value: rows[0] ? toDomain(rows[0]) : null };
    } catch (err) {
      return this.mapDbError(op, err, Date.now());
    }
  }

  private mapDbError(op: string, err: unknown, start: number): InviteStoreResult<never> {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error({
      operation: op,
      status: 'failure',
      error: message,
      error_type: err instanceof Error ? err.constructor.name : undefined,
      latency_ms: Date.now() - start,
    });
    return { ok: false, error: { code: 'DB_UNAVAILABLE', message } };
  }
}
