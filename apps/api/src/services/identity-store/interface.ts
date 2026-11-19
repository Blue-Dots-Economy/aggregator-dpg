/**
 * Identity-store contract (`@aggregator-dpg/api`).
 *
 * Links an account (`users.id`) to its login at an identity provider, in the
 * provider-neutral `user_identities` table. One login per provider per
 * account; one account per type per external login (an admin and a
 * coordinator may share a login). Never overwrites an existing link.
 *
 * Every method returns a `Result`-style union and never throws across the
 * service boundary.
 */

/** Errors an identity-store call can report. */
export type IdentityStoreError =
  | { code: 'DUPLICATE'; message: string }
  | { code: 'MISMATCH'; message: string }
  | { code: 'NOT_LINKABLE'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

/** Result of an identity-store call. */
export type IdentityStoreResult<T> =
  { ok: true; value: T } | { ok: false; error: IdentityStoreError };

/** Whether {@link IdentityStoreBase.link} recorded the link now or found it. */
export type LinkOutcome = 'linked' | 'already';

/** Abstract contract for the account ↔ IdP-login links. */
export abstract class IdentityStoreBase {
  /**
   * Links `subject` at `provider` to the account, once.
   *
   * @param userId - The account (`users.id`).
   * @param provider - Provider key (see `IDP_PROVIDER`).
   * @param subject - The provider's user id.
   * @param userType - When set, the account must be of this type.
   * @returns `'linked'` or `'already'`; `DUPLICATE` when the subject belongs to
   *   another account of the same type; `MISMATCH` when the account has a different subject;
   *   `NOT_LINKABLE` when the account is missing or of another type.
   */
  abstract link(
    userId: string,
    provider: string,
    subject: string,
    userType?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<LinkOutcome>>;

  /**
   * Returns the account's subject at `provider`, or null.
   *
   * @param userId - The account.
   * @param provider - Provider key.
   * @returns The subject or null.
   */
  abstract subjectOf(userId: string, provider: string): Promise<IdentityStoreResult<string | null>>;

  /**
   * Returns the account linked to `subject` at `provider`, or null.
   *
   * @param provider - Provider key.
   * @param subject - The provider's user id.
   * @param userType - When set, only an account of this type matches; when
   *   omitted the admin account wins over the coordinator.
   * @returns The account id or null.
   */
  abstract userOf(
    provider: string,
    subject: string,
    userType?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<string | null>>;

  /**
   * Returns both accounts linked to `subject` at `provider`.
   *
   * @param provider - Provider key.
   * @param subject - The provider's user id.
   * @returns The admin and coordinator account ids; null for a type with no link.
   */
  abstract accountsOf(
    provider: string,
    subject: string,
  ): Promise<IdentityStoreResult<{ admin: string | null; coordinator: string | null }>>;
}
