/**
 * Registration-invites store contract (#700).
 *
 * Persistence port for the `registration_invites` table — the row that backs
 * single-use, revocation, and leak attribution for email-bound coordinator
 * invites. The invite JWT's `sub` is a row's `jti`.
 *
 * Follows the repo base-class store pattern (`registration-links-store`):
 * abstract base, `StoreResult<T>`, driver errors normalised to `StoreError`
 * codes so callers never see raw pg fields.
 */

export type RegistrationInviteStatus = 'pending' | 'consumed' | 'revoked' | 'expired';

export interface RegistrationInvite {
  jti: string;
  role: string;
  parentOrgId: string;
  email: string;
  status: RegistrationInviteStatus;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface CreateInviteInput {
  parentOrgId: string;
  /** Normalised (lowercased, trimmed) by the caller before create. */
  email: string;
  expiresAt: Date;
  createdBy: string;
  /** Defaults to `coordinator`. */
  role?: string;
}

export interface RefreshInviteInput {
  expiresAt: Date;
  createdBy: string;
}

export type InviteStoreError =
  | { code: 'NOT_FOUND'; message: string }
  /** A live (pending) invite already exists for this (org, email). */
  | { code: 'DUPLICATE_PENDING'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type InviteStoreResult<T> = { ok: true; value: T } | { ok: false; error: InviteStoreError };

export abstract class RegistrationInvitesStoreBase {
  /**
   * Insert a new pending invite. Returns `DUPLICATE_PENDING` when a live
   * invite for the same (org, email) already exists (partial-unique index) so
   * the caller can fall back to {@link refresh} and report "already invited".
   */
  abstract create(input: CreateInviteInput): Promise<InviteStoreResult<RegistrationInvite>>;

  /** Load an invite by its `jti` (the token `sub`). */
  abstract findByJti(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /** Find the live (pending) invite for an (org, email), if any. */
  abstract findPendingByOrgAndEmail(
    parentOrgId: string,
    email: string,
  ): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /**
   * Refresh a pending invite's expiry + minting subject (a re-invite of an
   * already-invited address). Only touches a still-`pending` row; returns
   * `NOT_FOUND` otherwise.
   */
  abstract refresh(
    jti: string,
    input: RefreshInviteInput,
  ): Promise<InviteStoreResult<RegistrationInvite>>;

  /**
   * Atomically claim an invite: CAS `pending → consumed`, stamping
   * `consumed_at`. Returns the row on success, or `null` when the invite was
   * not pending (already consumed/revoked/expired, or a lost double-submit
   * race) — the caller renders already-registered rather than double-creating.
   */
  abstract consume(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;

  /**
   * Revoke a pending invite (CAS `pending → revoked`). Returns `null` when the
   * invite was not pending. Idempotent from the caller's view.
   */
  abstract revoke(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;
  /**
   * Compensating CAS `consumed → pending`, undoing a claim whose registration
   * never completed (#718 review). Scoped to `consumed` so a revoked or expired
   * invite can never be resurrected, and returns `null` when the row was not
   * consumed — the caller treats that as "nothing to give back".
   */
  abstract release(jti: string): Promise<InviteStoreResult<RegistrationInvite | null>>;
}
