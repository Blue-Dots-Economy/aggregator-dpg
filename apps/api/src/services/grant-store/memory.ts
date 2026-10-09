/**
 * In-memory grant store (`@aggregator-dpg/api`, RBAC R3). For unit tests.
 */

import { randomUUID } from 'node:crypto';
import {
  GrantStoreBase,
  type AuditEntry,
  type CreateGrantInput,
  type GrantStoreResult,
  type PermissionGrant,
} from './interface.js';

/** Map-backed {@link GrantStoreBase}; `audit` is readable by tests. */
export class InMemoryGrantStore extends GrantStoreBase {
  readonly grants: PermissionGrant[] = [];
  readonly audit: AuditEntry[] = [];

  /** {@inheritDoc GrantStoreBase.listLive} */
  async listLive(userId: string, now: Date): Promise<GrantStoreResult<PermissionGrant[]>> {
    return {
      ok: true,
      value: this.grants.filter(
        (g) => g.userId === userId && g.revokedAt === null && g.expiresAt > now,
      ),
    };
  }

  /** {@inheritDoc GrantStoreBase.listForUser} */
  async listForUser(userId: string): Promise<GrantStoreResult<PermissionGrant[]>> {
    return {
      ok: true,
      value: this.grants
        .filter((g) => g.userId === userId)
        .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime()),
    };
  }

  /** {@inheritDoc GrantStoreBase.grant} */
  async grant(
    input: CreateGrantInput,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant>> {
    const now = new Date();
    for (const g of this.grants) {
      if (g.userId === input.userId && g.grantKey === input.grantKey && g.revokedAt === null) {
        g.revokedAt = now;
        g.revokedBy = input.grantedBy;
      }
    }
    const created: PermissionGrant = {
      id: randomUUID(),
      ...input,
      grantedAt: now,
      revokedAt: null,
      revokedBy: null,
    };
    this.grants.push(created);
    this.audit.push(audit);
    return { ok: true, value: created };
  }

  /** {@inheritDoc GrantStoreBase.revoke} */
  async revoke(
    userId: string,
    grantKey: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant | null>> {
    const live = this.grants.find(
      (g) => g.userId === userId && g.grantKey === grantKey && g.revokedAt === null,
    );
    if (!live) return { ok: true, value: null };
    live.revokedAt = new Date();
    live.revokedBy = revokedBy;
    this.audit.push(audit);
    return { ok: true, value: live };
  }

  /** {@inheritDoc GrantStoreBase.recordAudit} */
  async recordAudit(entry: AuditEntry): Promise<GrantStoreResult<void>> {
    this.audit.push(entry);
    return { ok: true, value: undefined };
  }
}
