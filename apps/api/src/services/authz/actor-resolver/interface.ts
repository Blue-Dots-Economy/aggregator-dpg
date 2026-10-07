/**
 * Actor-resolver contract (`@aggregator-dpg/api`, RBAC R0).
 *
 * Turns a verified token into the facts an access decision needs: the
 * account, its type and state, the organisations it acts through, and its
 * grants. Read from the database on every request, so a revoke applies on the
 * next request.
 *
 * Built on the user-org model (`users.org_id`, `organisations.org_owner`,
 * `organisations.parent_id`). Refactor Phase 5's `resolveActor` can replace
 * the Postgres implementation behind this same contract.
 */

import type { OrgRelation, OrgType, Grant, UserType } from '@aggregator-dpg/rbac/interface';

/** Who the token says the caller is. */
export interface TokenIdentity {
  /** `aggregator_id` claim: the coordinator's `users.id`, when present. */
  aggregatorId?: string | undefined;
  /** Keycloak `sub`, looked up in `user_identities` when there is no `aggregator_id`. */
  subject: string;
}

/** An organisation the caller acts through, before config resolves its set. */
export interface ResolvedOrg {
  id: string;
  orgType: OrgType;
  relation: OrgRelation;
  /** The organisation's own PermissionSet name, or null for its `org_type` default. */
  permissionSet: string | null;
}

/** The caller, as stored. */
export interface ResolvedActor {
  userId: string;
  userType: UserType;
  active: boolean;
  orgs: ResolvedOrg[];
  grants: Grant[];
}

/** Errors a resolver call can report. */
export type ActorResolverError = { code: 'DB_UNAVAILABLE'; message: string };

/** Result of a resolver call. */
export type ActorResolverResult<T> =
  { ok: true; value: T } | { ok: false; error: ActorResolverError };

/** Abstract contract for resolving the caller. */
export abstract class ActorResolverBase {
  /**
   * Resolves the caller of a request.
   *
   * @param identity - Claims from the verified token.
   * @returns The actor, or null when no account matches the token.
   */
  abstract resolve(identity: TokenIdentity): Promise<ActorResolverResult<ResolvedActor | null>>;

  /**
   * Returns an organisation and its ancestors, target first.
   *
   * @param orgId - The organisation.
   * @returns `[orgId, parent, …, root]`; empty when the organisation does not exist.
   */
  abstract orgChain(orgId: string): Promise<ActorResolverResult<string[]>>;
}
