/**
 * Postgres adapter for the registration-invites store (#700).
 *
 * Wraps Drizzle queries against `registration_invites`. Driver-specific errors
 * are mapped to abstract `InviteStoreError` codes — callers reason in domain
 * terms. The partial-unique index on (parent_org_id, email) WHERE
 * status='pending' surfaces as `DUPLICATE_PENDING`.
 */

import { and, eq } from 'drizzle-orm';
import { logger } from '../../logger.js';
import { registrationInvites, type RegistrationInviteRow } from '../../db/schema.js';
import { getDb } from '../../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/pg-error.js';
import {
  RegistrationInvitesStoreBase,
  type CreateInviteInput,
  type InviteStoreResult,
  type RefreshInviteInput,
  type RegistrationInvite,
} from './interface.js';

function toDomain(row: RegistrationInviteRow): RegistrationInvite {
  return {
    jti: row.jti,
    role: row.role,
    parentOrgId: row.parentOrgId,
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
          parentOrgId: input.parentOrgId,
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
    email: string,
  ): Promise<InviteStoreResult<RegistrationInvite | null>> {
    try {
      const [row] = await getDb()
        .select()
        .from(registrationInvites)
        .where(
          and(
            eq(registrationInvites.parentOrgId, parentOrgId),
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
   * Shared CAS `pending → next` used by consume/revoke. Returns the row on a
   * winning swap, `null` when the invite was not pending.
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
