/**
 * Postgres role-assignment store (`@aggregator-dpg/api`, RBAC, migration 0030).
 *
 * `user_role` and `iam_audit`; every write commits with its audit row. One
 * live row per (user, role, organisation) is held by a partial unique index.
 * Logs SQLSTATE only — never the driver message, which carries query
 * parameters.
 */

import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { iamAudit, userRole } from '../../db/schema.js';
import { pgErrorCode } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import {
  RoleStoreBase,
  type AssignRoleInput,
  type AuditEntry,
  type RoleStoreResult,
  type UserRoleRecord,
} from './interface.js';

type Row = typeof userRole.$inferSelect;

function toDomain(r: Row): UserRoleRecord {
  return {
    id: r.id,
    userId: r.userId,
    roleKey: r.roleKey,
    orgId: r.orgId,
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
  };
}

function auditValues(e: AuditEntry) {
  return {
    event: e.event,
    actorUserId: e.actorUserId,
    targetUserId: e.targetUserId ?? null,
    targetOrgId: e.targetOrgId ?? null,
    details: e.details ?? {},
  };
}

/** Logs a driver failure (SQLSTATE only) and maps it to `DB_UNAVAILABLE`. */
function dbFailure(op: string, e: unknown): RoleStoreResult<never> {
  logger.warn({ operation: op, status: 'failure', sqlstate: pgErrorCode(e) });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } };
}

/** The live assignment of one role in one organisation. */
const liveOf = (userId: string, roleKey: string, orgId: string) =>
  and(
    eq(userRole.userId, userId),
    eq(userRole.roleKey, roleKey),
    eq(userRole.orgId, orgId),
    isNull(userRole.revokedAt),
  );

/** Postgres-backed {@link RoleStoreBase}. */
export class PostgresRoleStore extends RoleStoreBase {
  /** {@inheritDoc RoleStoreBase.listLive} */
  async listLive(userId: string, now: Date): Promise<RoleStoreResult<UserRoleRecord[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(userRole)
        .where(
          and(
            eq(userRole.userId, userId),
            isNull(userRole.revokedAt),
            or(isNull(userRole.expiresAt), gt(userRole.expiresAt, now)),
          ),
        );
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return dbFailure('roleStore.listLive', e);
    }
  }

  /** {@inheritDoc RoleStoreBase.listLiveForUsers} */
  async listLiveForUsers(
    userIds: readonly string[],
    now: Date,
  ): Promise<RoleStoreResult<UserRoleRecord[]>> {
    if (userIds.length === 0) return { ok: true, value: [] };
    try {
      const rows = await getDb()
        .select()
        .from(userRole)
        .where(
          and(
            inArray(userRole.userId, [...userIds]),
            isNull(userRole.revokedAt),
            or(isNull(userRole.expiresAt), gt(userRole.expiresAt, now)),
          ),
        );
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return dbFailure('roleStore.listLiveForUsers', e);
    }
  }

  /** {@inheritDoc RoleStoreBase.listForUser} */
  async listForUser(userId: string): Promise<RoleStoreResult<UserRoleRecord[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(userRole)
        .where(eq(userRole.userId, userId))
        .orderBy(desc(userRole.grantedAt));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return dbFailure('roleStore.listForUser', e);
    }
  }

  /** {@inheritDoc RoleStoreBase.assign} */
  async assign(
    input: AssignRoleInput,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord>> {
    try {
      const created = await getDb().transaction(async (tx) => {
        await tx
          .update(userRole)
          .set({ revokedAt: new Date(), revokedBy: input.grantedBy })
          .where(liveOf(input.userId, input.roleKey, input.orgId));
        const [row] = await tx
          .insert(userRole)
          .values({
            userId: input.userId,
            roleKey: input.roleKey,
            orgId: input.orgId,
            grantedBy: input.grantedBy,
            expiresAt: input.expiresAt,
          })
          .returning();
        await tx.insert(iamAudit).values(auditValues(audit));
        return row;
      });
      if (!created) return dbFailure('roleStore.assign', new Error('no row returned'));
      return { ok: true, value: toDomain(created) };
    } catch (e) {
      return dbFailure('roleStore.assign', e);
    }
  }

  /** {@inheritDoc RoleStoreBase.revoke} */
  async revoke(
    userId: string,
    roleKey: string,
    orgId: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<UserRoleRecord | null>> {
    try {
      const revoked = await getDb().transaction(async (tx) => {
        const [row] = await tx
          .update(userRole)
          .set({ revokedAt: new Date(), revokedBy })
          .where(liveOf(userId, roleKey, orgId))
          .returning();
        if (row) await tx.insert(iamAudit).values(auditValues(audit));
        return row ?? null;
      });
      return { ok: true, value: revoked ? toDomain(revoked) : null };
    } catch (e) {
      return dbFailure('roleStore.revoke', e);
    }
  }

  /** {@inheritDoc RoleStoreBase.revokeAllInOrg} */
  async revokeAllInOrg(
    userId: string,
    orgId: string,
    revokedBy: string | null,
    audit: AuditEntry,
  ): Promise<RoleStoreResult<number>> {
    try {
      const n = await getDb().transaction(async (tx) => {
        const rows = await tx
          .update(userRole)
          .set({ revokedAt: new Date(), revokedBy })
          .where(
            and(eq(userRole.userId, userId), eq(userRole.orgId, orgId), isNull(userRole.revokedAt)),
          )
          .returning({ id: userRole.id });
        if (rows.length > 0) await tx.insert(iamAudit).values(auditValues(audit));
        return rows.length;
      });
      return { ok: true, value: n };
    } catch (e) {
      return dbFailure('roleStore.revokeAllInOrg', e);
    }
  }
}
