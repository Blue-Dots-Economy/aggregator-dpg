/**
 * Permission checks for the API (`@aggregator-dpg/api`, RBAC; design §3).
 *
 * Expands a resolved actor's base roles (from its memberships) and live
 * additional roles into permissions, for the organisation acted on and its
 * ancestors (or every organisation the actor belongs to or owns, for a route
 * with no single target), asks the decision engine, and logs the outcome. In
 * `log` mode a deny is only logged; in `enforce` mode the caller turns
 * `allowed: false` into a 403. Reach (which targets) is not decided here:
 * `scope.ts` answers it with 404 (design decision D3).
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  CAPABILITIES,
  effectivePermissions,
  type AuthorizerBase,
  type Capability,
  type Decision,
  type DecisionInput,
  type OrgType,
  type RoleIndex,
} from '@aggregator-dpg/rbac';
import { getActorResolver, type Actor } from '../auth/actor/index.js';
import { getRbacRuntime, type RbacMode } from './runtime.js';

/** What the caller should do with the request. */
export interface GuardOutcome {
  /** False only in `enforce` mode, for a deny. */
  allowed: boolean;
  mode: RbacMode;
  /** The decision, when a check ran. */
  decision?: Decision;
}

/** The request facts the guard needs. */
export interface GuardRequest {
  log: FastifyBaseLogger;
  routeOptions?: { url?: string | undefined };
  method?: string | undefined;
}

/** The organisation a request acts on. */
export interface TargetOrg {
  id: string;
  orgType: OrgType;
  /** Its ancestors, nearest first (the root for an aggregator organisation). */
  ancestorIds: string[];
}

/** Optional inputs of a check. */
export interface CheckOptions {
  /** The organisation acted on; omitted = every organisation the actor relates to. */
  target?: TargetOrg | undefined;
  /** Clock, for role expiry. Injectable for tests. */
  now?: number | undefined;
  /**
   * Deny in `log` mode too. For checks on surfaces that did not exist before
   * RBAC (the role and custom-role writes): there is no legacy behaviour for
   * `log` to preserve, so an IAM write is never open while RBAC is on.
   */
  strict?: boolean | undefined;
}

/** Who the token says the caller is. */
export interface TokenIdentity {
  /** `aggregator_id` claim, when present. */
  aggregatorId?: string | undefined;
  /** Keycloak `sub`. */
  subject: string;
}

/**
 * Resolves the caller through Phase 5's actor resolver.
 *
 * @param identity - Claims from the verified token.
 * @returns The actor, or a deny reason (`actor_unavailable`, `unknown_actor`).
 */
export async function resolveCaller(
  identity: TokenIdentity,
): Promise<{ actor: Actor } | { reason: string }> {
  const res = await getActorResolver().resolve({
    subject: identity.subject,
    ...(identity.aggregatorId ? { aggregatorId: identity.aggregatorId } : {}),
  });
  if (!res.ok) return { reason: 'actor_unavailable' };
  if (!res.value) return { reason: 'unknown_actor' };
  return { actor: res.value };
}

/**
 * The permissions an actor holds where a request applies: its base roles
 * (from its memberships) and live additional roles, expanded through the
 * role snapshot.
 *
 * @param roles - The role snapshot.
 * @param actor - The resolved actor.
 * @param target - The organisation acted on, or undefined for every organisation the actor relates to.
 * @param now - Clock, for role expiry.
 * @returns The permissions, sorted.
 */
export function actorPermissions(
  roles: RoleIndex,
  actor: Actor,
  target: TargetOrg | undefined,
  now: number,
): Capability[] {
  return effectivePermissions(
    roles,
    {
      userType: actor.userType,
      memberships: actor.orgs.map((o) => ({
        orgId: o.id,
        orgType: o.orgType,
        relation: o.relation,
      })),
      held: actor.roles ?? [],
    },
    target ? new Set([target.id, ...target.ancestorIds]) : null,
    now,
  );
}

/**
 * Builds the policy input for one question.
 *
 * @param roles - The role snapshot.
 * @param actor - The resolved actor.
 * @param capability - The permission asked for.
 * @param target - The organisation acted on, or undefined.
 * @param now - Clock, for role expiry.
 * @returns The decision input.
 */
export function decisionInput(
  roles: RoleIndex,
  actor: Actor,
  capability: Capability,
  target: TargetOrg | undefined,
  now: number,
): DecisionInput {
  return {
    capability,
    actor: {
      userId: actor.userId,
      active: actor.active,
      permissions: actorPermissions(roles, actor, target, now),
    },
    org: target ? { id: target.id, orgType: target.orgType } : null,
  };
}

/** Asks the engine; an engine failure becomes a deny. */
async function decide(authorizer: AuthorizerBase, input: DecisionInput): Promise<Decision> {
  const result = await authorizer.decide(input);
  return result.success ? result.value : { allow: false, reasons: ['engine_unavailable'] };
}

/** Logs a decision and turns it into an outcome for the mode. */
function outcome(
  req: GuardRequest,
  mode: Exclude<RbacMode, 'off'>,
  capability: Capability,
  userId: string | undefined,
  decision: Decision,
  start: number,
): GuardOutcome {
  const entry = {
    operation: 'rbac.decide',
    capability,
    route: req.routeOptions?.url,
    method: req.method,
    user_id: userId,
    mode,
    allow: decision.allow,
    reasons: decision.reasons,
    latency_ms: Date.now() - start,
  };
  if (decision.allow) {
    req.log.debug({ ...entry, status: 'success' });
    return { allowed: true, mode, decision };
  }
  req.log.warn({ ...entry, status: mode === 'enforce' ? 'failure' : 'skipped' });
  return { allowed: mode !== 'enforce', mode, decision };
}

/**
 * Checks whether a resolved actor holds `capability`, in the target
 * organisation when one is given. Never throws.
 *
 * Use it inside a handler once the target is known, and for checks that do
 * not fail the whole route, such as unmasking contact details.
 *
 * @param req - The request (for its logger and route).
 * @param actor - The resolved actor.
 * @param capability - The permission asked for.
 * @param options - The organisation acted on, and a clock for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function checkCapability(
  req: GuardRequest,
  actor: Actor,
  capability: Capability,
  options: CheckOptions = {},
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };
  const start = Date.now();
  const input = decisionInput(
    rt.roles,
    actor,
    capability,
    options.target,
    options.now ?? Date.now(),
  );
  const decision = await decide(rt.authorizer, input);
  const mode = options.strict ? 'enforce' : rt.mode;
  return outcome(req, mode, capability, actor.userId, decision, start);
}

/**
 * Resolves the caller, then checks `capability`. Never throws: an unknown
 * caller, a database failure or an unreachable engine count as a deny.
 *
 * @param req - The request (for its logger and route).
 * @param identity - Claims from the verified token.
 * @param capability - The permission the route declares.
 * @param options - `strict` (deny in `log` mode too) and a clock for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function requirePermission(
  req: GuardRequest,
  identity: TokenIdentity,
  capability: Capability,
  options: Omit<CheckOptions, 'target'> = {},
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };
  const start = Date.now();
  const resolved = await resolveCaller(identity);
  if ('reason' in resolved) {
    return outcome(
      req,
      options.strict ? 'enforce' : rt.mode,
      capability,
      identity.aggregatorId,
      { allow: false, reasons: [resolved.reason] },
      start,
    );
  }
  return checkCapability(req, resolved.actor, capability, options);
}

/**
 * Lists the permissions a resolved actor holds, for the portal. Never throws.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param options - The organisation acted on (default: every organisation the actor relates to), and a clock for tests.
 * @returns The held permissions; `null` when RBAC is off (no restriction);
 *   an empty list when the engine cannot answer (the API still decides).
 */
export async function listActorCapabilities(
  req: GuardRequest,
  actor: Actor,
  options: CheckOptions = {},
): Promise<Capability[] | null> {
  const rt = getRbacRuntime();
  if (!rt) return null;
  const target = options.target;
  const res = await rt.authorizer.listCapabilities({
    actor: {
      userId: actor.userId,
      active: actor.active,
      permissions: actorPermissions(rt.roles, actor, target, options.now ?? Date.now()),
    },
    org: target ? { id: target.id, orgType: target.orgType } : null,
    candidates: [...CAPABILITIES],
  });
  if (res.success) return res.value;
  req.log.warn({
    operation: 'rbac.capabilities',
    status: 'failure',
    user_id: actor.userId,
    error: res.error.message,
    error_type: res.error.code,
  });
  return [];
}

/**
 * Lists the permissions a resolved actor holds in each of several
 * organisations, asking the engine once per *distinct* question.
 *
 * `listCapabilities` is decided purely from the actor's expanded permissions
 * and the organisation's type, so two targets that produce the same pair ask
 * the same question. An owner of many organisations normally holds the same
 * role in each, which collapses to a single call instead of one per
 * organisation on a route the portal loads on every render.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param targets - The organisations to answer for.
 * @param now - Clock, for role expiry. Injectable for tests.
 * @returns Permissions per organisation id; `null` when RBAC is off.
 */
export async function listCapabilitiesForTargets(
  req: GuardRequest,
  actor: Actor,
  targets: readonly TargetOrg[],
  now: number = Date.now(),
): Promise<Map<string, Capability[]> | null> {
  if (!getRbacRuntime()) return null;
  const out = new Map<string, Capability[]>();
  // Key the memo on what the engine actually sees, not on the organisation:
  // same permissions + same org type ⇒ same answer.
  const answers = new Map<string, Promise<Capability[] | null>>();
  for (const target of targets) {
    const rt = getRbacRuntime();
    if (!rt) return null;
    const permissions = actorPermissions(rt.roles, actor, target, now);
    const key = JSON.stringify([permissions, target.orgType]);
    let answer = answers.get(key);
    if (!answer) {
      answer = listActorCapabilities(req, actor, { target, now });
      answers.set(key, answer);
    }
    out.set(target.id, (await answer) ?? []);
  }
  return out;
}
