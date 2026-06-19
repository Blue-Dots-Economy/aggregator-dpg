/**
 * Identity-provider admin contract.
 *
 * The API only needs a small slice of admin operations to support the
 * aggregator approval flow: create a user, look one up by email, enable /
 * disable, delete (rollback). Everything else stays vendor-specific in the
 * concrete adapter. Swap implementations to support FusionAuth, Authentik,
 * Auth0, etc. without touching business logic.
 */

export interface CreateUserInput {
  email: string;
  /** Phone in E.164 format. Stored as `phoneNumber` user attribute. */
  phone?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  enabled?: boolean;
  /** Free-form attributes. Existing fields take precedence. */
  attributes?: Record<string, string | string[]>;
  /**
   * Keycloak required actions to attach to the new user. Used to defer
   * collection of fields not captured at registration time — e.g. the
   * applicant fills first/last name via KC's Update Profile screen on
   * their first sign-in.
   */
  requiredActions?: string[];
}

export interface IdpUser {
  id: string;
  email: string;
  username: string;
  enabled: boolean;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string[]>;
}

export type IdpResult<T> = { ok: true; value: T } | { ok: false; error: IdpError };

export type IdpError =
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'USER_EXISTS'; message: string }
  | { code: 'USER_NOT_FOUND'; message: string }
  | { code: 'IDP_UNAVAILABLE'; message: string }
  | { code: 'BAD_REQUEST'; message: string };

/**
 * Abstract IdP admin port. Concrete impls extend this base.
 */
export abstract class IdpAdminAdapter {
  abstract createUser(input: CreateUserInput): Promise<IdpResult<IdpUser>>;
  abstract findByEmail(email: string): Promise<IdpResult<IdpUser | null>>;
  abstract findById(userId: string): Promise<IdpResult<IdpUser | null>>;
  /**
   * Look up a user by a free-form attribute name/value pair.
   *
   * Used to map an aggregator UUID (stored as the `aggregator_id` user
   * attribute on the Keycloak user) back to the identity record without
   * keeping a redundant Keycloak user id in Postgres.
   */
  abstract findByAttribute(name: string, value: string): Promise<IdpResult<IdpUser | null>>;
  abstract enableUser(userId: string): Promise<IdpResult<void>>;
  abstract disableUser(userId: string): Promise<IdpResult<void>>;
  abstract deleteUser(userId: string): Promise<IdpResult<void>>;
  /**
   * Merge attributes onto an existing user. Implementations preserve other
   * attributes already on the user; only the keys provided here are written
   * (or removed when the value is `null`).
   */
  abstract setAttributes(
    userId: string,
    attributes: Record<string, string | string[] | null>,
  ): Promise<IdpResult<void>>;

  /**
   * Write only the `decision_made` attribute on a user. Convenience wrapper
   * around {@link setAttributes} so the approval flow does not need to know
   * the attribute name. Use `enableUser` / `disableUser` separately when
   * the decision affects login (typically `approved` → enable, `rejected` →
   * disable).
   *
   * @param userId  - Keycloak user id (from `findByAttribute(aggregator_id)`).
   * @param decision - One of `'pending'`, `'approved'`, `'rejected'`.
   */
  abstract setUserDecision(
    userId: string,
    decision: 'pending' | 'approved' | 'rejected',
  ): Promise<IdpResult<void>>;
}
