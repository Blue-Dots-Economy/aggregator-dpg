/**
 * Grant-store contract (`@aggregator-dpg/api`, RBAC R3, migration 0030).
 *
 * Capabilities granted to one user on top of their role (PII Access), with an
 * expiry, and the append-only `iam_audit` trail of grant and PermissionSet
 * changes. Every write and its audit row commit together.
 *
 * Every method returns a `Result`-style union and never throws across the
 * service boundary.
 */

import type { Capability } from '@aggregator-dpg/rbac/interface';

/** One grant, live or historical. */
export interface PermissionGrant {
  id: string;
  userId: string;
  /** Key in `rbac.yaml` `grants`, e.g. `pii_access`. */
  grantKey: string;
  capability: Capability;
  grantedBy: string | null;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}

/** An `iam_audit` entry. Ids and names only — never contact data. */
export interface AuditEntry {
  event: string;
  actorUserId: string | null;
  targetUserId?: string | null;
  targetOrgId?: string | null;
  details?: Record<string, unknown>;
}

/** Input of {@link GrantStoreBase.grant}. */
export interface CreateGrantInput {
  userId: string;
  grantKey: string;
  capability: Capability;
  grantedBy: string;
  expiresAt: Date;
}

/** Errors a grant-store call can report. */
export type GrantStoreError = { code: 'DB_UNAVAILABLE'; message: string };

/** Result of a grant-store call. */
export type GrantStoreResult<T> = { ok: true; value: T } | { ok: false; error: GrantStoreError };

/** Abstract contract for per-user grants and the IAM audit. */
export abstract class GrantStoreBase {
  /**
   * Returns the user's live grants: not revoked and not expired at `now`.
   *
   * @param userId - The user.
   * @param now - The current time.
   * @returns The live grants.
   */
  abstract listLive(userId: string, now: Date): Promise<GrantStoreResult<PermissionGrant[]>>;

  /**
   * Returns every grant of the user, newest first (live, expired and revoked).
   *
   * @param userId - The user.
   * @returns The grants.
   */
  abstract listForUser(userId: string): Promise<GrantStoreResult<PermissionGrant[]>>;

  /**
   * Grants a capability, replacing the user's live grant of the same key
   * (revoked by the same actor), and writes `audit` in the same transaction.
   *
   * @param input - The grant.
   * @param audit - The audit entry.
   * @returns The new grant.
   */
  abstract grant(
    input: CreateGrantInput,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant>>;

  /**
   * Revokes the user's live grant of `grantKey`, if any, and writes `audit`
   * in the same transaction (only when something was revoked).
   *
   * @param userId - The user.
   * @param grantKey - The grant key.
   * @param revokedBy - The acting admin.
   * @param audit - The audit entry.
   * @returns The revoked grant, or null when there was none.
   */
  abstract revoke(
    userId: string,
    grantKey: string,
    revokedBy: string,
    audit: AuditEntry,
  ): Promise<GrantStoreResult<PermissionGrant | null>>;

  /**
   * Appends an audit entry on its own (e.g. a PermissionSet change).
   *
   * @param entry - The entry.
   * @returns Ok when written.
   */
  abstract recordAudit(entry: AuditEntry): Promise<GrantStoreResult<void>>;
}
