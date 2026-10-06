/**
 * Actor-resolver contract (`@aggregator-dpg/api`, RBAC R0).
 *
 * Turns a verified token into the facts an access decision needs: the
 * account, its type and state, the organisations it acts through, and its
 * grants. Read from the database on every request, so a revoke applies on the
 * next request.
 *
 * Built on today's schema (`users`, `aggregator_orgs.owner_user_id`,
 * `users.parent_org_id`). Refactor Phase 5's `resolveActor` replaces the
 * Postgres implementation behind this same contract.
 */

import type { OrgRelation, OrgType, Grant, UserType } from '@aggregator-dpg/rbac/interface';

/** Who the token says the caller is. */
export interface TokenIdentity {
  /** `aggregator_id` claim: the coordinator's `users.id`, when present. */
  aggregatorId?: string;
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

/** Placeholder organisation id for coordinators without one, until refactor Phase 3's Default org. */
export const DEFAULT_ORG_PLACEHOLDER = 'default';

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
   * @returns `[orgId, parent, …, root]`; `[orgId]` while organisations have no parents.
   */
  abstract orgChain(orgId: string): Promise<ActorResolverResult<string[]>>;
}
