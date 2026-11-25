/**
 * Actor-resolver contract, in the aggregator API (`@aggregator-dpg/api`).
 *
 * Answers who is calling and which organisations they relate to, for a
 * verified token. The database is the authority, read on every request, so
 * ownership changes apply without a re-login.
 *
 * Shape: `resolve({ userId?, subject })` → `{ userId, userType, active, orgs, roles? }`.
 * Base roles follow `orgs`; additional roles come from `user_role`.
 *
 * Never throws across the service boundary.
 */

import type { HeldRole } from '@aggregator-dpg/rbac/interface';

/** How the actor relates to an organisation. */
export type ActorOrgRelation = 'member' | 'owner';

/** One organisation the actor relates to. */
export interface ActorOrg {
  id: string;
  orgType: 'network_facilitator' | 'aggregator';
  relation: ActorOrgRelation;
  /** The fixed Default org (`slug = 'default'`). */
  isDefault: boolean;
}

/** The resolved caller. */
export interface Actor {
  /** `users.id`. */
  userId: string;
  userType: 'admin' | 'coordinator';
  /**
   * Coordinator: the registration is approved (`status = 'active'`).
   * Admin: owns at least one active organisation.
   */
  active: boolean;
  /**
   * Coordinator: its own org (`member`). Admin: the active orgs it owns
   * (`owner`), the root among them for the network admin.
   */
  orgs: ActorOrg[];
  /**
   * The user's live additional roles (`user_role`: not revoked, not expired
   * when read). Absent: none.
   */
  roles?: HeldRole[];
}

/** Input of {@link ActorResolverBase.resolve}: verified token claims. */
export interface ResolveActorInput {
  /** The user's `users.id`, from the `user_id` claim, else `aggregator_id`, when the token carries one. */
  userId?: string;
  /** The token's `sub` (the IdP login). */
  subject: string;
  /**
   * The `x-acting-account` header: the owner's own coordinator account on
   * the same login. Absent: the caller acts as itself.
   */
  actingAccountId?: string;
}

/** Errors a resolve can report. */
export type ActorResolveError = {
  /** `ACTING_ACCOUNT_INVALID`: the login may not act as `actingAccountId`. */
  code: 'UNAVAILABLE' | 'ACTING_ACCOUNT_INVALID';
  message: string;
};

/** Result of a resolve; `null` when no account matches the token. */
export type ActorResult =
  { ok: true; value: Actor | null } | { ok: false; error: ActorResolveError };

/** Resolves the account behind a verified token. */
export abstract class ActorResolverBase {
  /**
   * Resolves the caller's account and organisations.
   *
   * A token with `aggregator_id` resolves to that coordinator; one without
   * resolves through the recorded IdP login (`user_identities`), never by email.
   * With `actingAccountId` and no `aggregator_id`, it resolves to that
   * coordinator when the login may act as it.
   *
   * @param input - Verified claims.
   * @returns The actor, `null` when the token maps to no account,
   *   `ACTING_ACCOUNT_INVALID` when the acting account is refused, or
   *   `UNAVAILABLE` when a store failed.
   */
  abstract resolve(input: ResolveActorInput): Promise<ActorResult>;
}
