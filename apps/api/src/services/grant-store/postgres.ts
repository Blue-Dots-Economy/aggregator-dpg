/**
 * Postgres grant store (`@aggregator-dpg/api`, RBAC R3, migration 0030).
 *
 * `user_permission_grant` and `iam_audit`; every write commits with its audit
 * row. Logs SQLSTATE only — never the driver message, which carries query
 * parameters.
 */

import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Capability } from '@aggregator-dpg/rbac/interface';
import { getDb } from '../../db/client.js';
import { iamAudit, userPermissionGrant } from '../../db/schema.js';
import { pgErrorCode } from '../../db/pg-error.js';
import { logger } from '../../logger.js';
import {
  GrantStoreBase,
  type AuditEntry,
  type CreateGrantInput,
  type GrantStoreResult,
  type PermissionGrant,
} from './interface.js';

type Row = typeof userPermissionGrant.$inferSelect;

function toDomain(r: Row): PermissionGrant {
  return {
    id: r.id,
    userId: r.userId,
    grantKey: r.grantKey,
    capability: r.capability as Capability,
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
function dbFailure(op: string, e: unknown): GrantStoreResult<never> {
  logger.warn({ operation: op, status: 'failure', sqlstate: pgErrorCode(e) });
  return { ok: false, error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } };
}

/** Postgres-backed {@link GrantStoreBase}. */
export class PostgresGrantStore extends GrantStoreBase {
  /** {@inheritDoc GrantStoreBase.listLive} */
  async listLive(userId: string, now: Date): Promise<GrantStoreResult<PermissionGrant[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(userPermissionGrant)
        .where(
          and(
            eq(userPermissionGrant.userId, userId),
            isNull(userPermissionGrant.revokedAt),
            gt(userPermissionGrant.expiresAt, now),
          ),
        );
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return dbFailure('grantStore.listLive', e);
    }
  }

  /** {@inheritDoc GrantStoreBase.listForUser} */
  async listForUser(userId: string): Promise<GrantStoreResult<PermissionGrant[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(userPermissionGrant)
        .where(eq(userPermissionGrant.userId, userId))
        .orderBy(desc(userPermissionGrant.grantedAt));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return dbFailure('grantStore.listForUser', e);
    }
  }

  /** {@inheritDoc GrantStoreBase.grant} */
  async grant(
    input: CreateGrantInput,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant>> {
    try {
      const created = await getDb().transaction(async (tx) => {
        await tx
          .update(userPermissionGrant)
          .set({ revokedAt: new Date(), revokedBy: input.grantedBy })
          .where(
            and(
              eq(userPermissionGrant.userId, input.userId),
              eq(userPermissionGrant.grantKey, input.grantKey),
              isNull(userPermissionGrant.revokedAt),
            ),
          );
        const [row] = await tx
          .insert(userPermissionGrant)
          .values({
            userId: input.userId,
            grantKey: input.grantKey,
            capability: input.capability,
            grantedBy: input.grantedBy,
            expiresAt: input.expiresAt,
          })
          .returning();
        await tx.insert(iamAudit).values(auditValues(audit));
        return row;
      });
      if (!created) return dbFailure('grantStore.grant', new Error('no row returned'));
      return { ok: true, value: toDomain(created) };
    } catch (e) {
      return dbFailure('grantStore.grant', e);
    }
  }

  /** {@inheritDoc GrantStoreBase.revoke} */
  async revoke(
    userId: string,
    grantKey: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant | null>> {
    try {
      const revoked = await getDb().transaction(async (tx) => {
        const [row] = await tx
          .update(userPermissionGrant)
          .set({ revokedAt: new Date(), revokedBy })
          .where(
            and(
              eq(userPermissionGrant.userId, userId),
              eq(userPermissionGrant.grantKey, grantKey),
              isNull(userPermissionGrant.revokedAt),
            ),
          )
          .returning();
        if (row) await tx.insert(iamAudit).values(auditValues(audit));
        return row ?? null;
      });
      return { ok: true, value: revoked ? toDomain(revoked) : null };
    } catch (e) {
      return dbFailure('grantStore.revoke', e);
    }
  }

  /** {@inheritDoc GrantStoreBase.recordAudit} */
  async recordAudit(entry: AuditEntry): Promise<GrantStoreResult<void>> {
    try {
      await getDb().insert(iamAudit).values(auditValues(entry));
      return { ok: true, value: undefined };
    } catch (e) {
      return dbFailure('grantStore.recordAudit', e);
    }
  }
}
