/**
 * Actor-resolver contract (`@aggregator-dpg/api`, user & org Phase 5).
 *
 * Answers "who is calling, and which organisations do they relate to" for a
 * verified token. The database, not the token, is the authority: ownership
 * changes without a re-login, so the resolver reads it on every request.
 *
 * The shape mirrors the RBAC work's `ActorResolverBase`
 * (`resolve({ aggregatorId?, subject })` → `{ userId, userType, active, orgs }`)
 * so RBAC can adopt this resolver or replace it behind the same contract
 * (`docs/rbac/phase-5-rbac-handoff.md`, H-3). RBAC adds `grants` and `permissionSet`.
 *
 * Never throws across the service boundary.
 */

import type { Grant } from '@aggregator-dpg/rbac/interface';

/** How the actor relates to an organisation. */
export type ActorOrgRelation = 'member' | 'owner';

/** One organisation the actor relates to. */
export interface ActorOrg {
  id: string;
  orgType: 'network_facilitator' | 'aggregator';
  relation: ActorOrgRelation;
  /** The fixed Default org (`slug = 'default'`). */
  isDefault: boolean;
  /**
   * The organisation's own PermissionSet name (RBAC R3). Absent or null: the
   * `org_type` default from `config/rbac.yaml`.
   */
  permissionSet?: string | null;
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
  /** Per-user grants on top of the role (RBAC R3, e.g. PII Access). Absent: none. */
  grants?: Grant[];
}

/** Input of {@link ActorResolverBase.resolve}: verified token claims. */
export interface ResolveActorInput {
  /** The `aggregator_id` claim, when the token carries one. */
  aggregatorId?: string;
  /** The token's `sub` (the IdP login). */
  subject: string;
}

/** Errors a resolve can report. */
export type ActorResolveError = { code: 'UNAVAILABLE'; message: string };

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
   *
   * @param input - Verified claims.
   * @returns The actor, `null` when the token maps to no account, or
   *   `UNAVAILABLE` when a store failed.
   */
  abstract resolve(input: ResolveActorInput): Promise<ActorResult>;
}
