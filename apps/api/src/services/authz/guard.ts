/**
 * Capability checks for the API (`@aggregator-dpg/api`, RBAC).
 *
 * Builds the decision input from a resolved actor (Phase 5's actor resolver)
 * and `config/rbac.yaml`, asks the decision engine, and logs the outcome. In
 * `log` mode a deny is only logged; in `enforce` mode the caller turns
 * `allowed: false` into a 403. Reach (which targets) is not decided here:
 * `scope.ts` answers it with 404 (design decision D3).
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  CAPABILITIES,
  orgCapabilities,
  roleCapabilities,
  type AuthorizerBase,
  type Capability,
  type Decision,
  type DecisionInput,
  type RbacConfig,
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
 * Builds the policy input for an actor.
 *
 * @param cfg - The validated `rbac.yaml`.
 * @param actor - The resolved actor.
 * @param capability - The capability asked for.
 * @param now - Clock, for grant expiry.
 * @returns The decision input.
 */
export function decisionInput(
  cfg: RbacConfig,
  actor: Actor,
  capability: Capability,
  now: number,
): DecisionInput {
  return { capability, now, actor: actorInput(cfg, actor) };
}

/**
 * The policy's view of an actor: role and organisation capabilities from
 * `rbac.yaml`, and the actor's grants.
 *
 * @param cfg - The validated `rbac.yaml`.
 * @param actor - The resolved actor.
 * @returns The `actor` part of a policy input.
 */
export function actorInput(cfg: RbacConfig, actor: Actor): DecisionInput['actor'] {
  return {
    userId: actor.userId,
    userType: actor.userType,
    active: actor.active,
    roleCapabilities: roleCapabilities(cfg, actor.userType),
    grants: actor.grants ?? [],
    orgs: actor.orgs.map((o) => ({
      id: o.id,
      orgType: o.orgType,
      relation: o.relation,
      capabilities: orgCapabilities(cfg, o.orgType, o.permissionSet ?? null),
    })),
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
 * Checks whether a resolved actor holds `capability`. Never throws.
 *
 * Use it inside a handler for checks that do not fail the whole route, such
 * as unmasking contact details.
 *
 * @param req - The request (for its logger and route).
 * @param actor - The resolved actor.
 * @param capability - The capability asked for.
 * @param now - Clock, for grant expiry. Injectable for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function checkCapability(
  req: GuardRequest,
  actor: Actor,
  capability: Capability,
  now: number = Date.now(),
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };
  const start = Date.now();
  const decision = await decide(rt.authorizer, decisionInput(rt.config, actor, capability, now));
  return outcome(req, rt.mode, capability, actor.userId, decision, start);
}

/**
 * Resolves the caller, then checks `capability`. Never throws: an unknown
 * caller, a database failure or an unreachable engine count as a deny.
 *
 * @param req - The request (for its logger and route).
 * @param identity - Claims from the verified token.
 * @param capability - The capability the route declares.
 * @param now - Clock, for grant expiry. Injectable for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function requirePermission(
  req: GuardRequest,
  identity: TokenIdentity,
  capability: Capability,
  now: number = Date.now(),
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };
  const start = Date.now();
  const resolved = await resolveCaller(identity);
  if ('reason' in resolved) {
    return outcome(
      req,
      rt.mode,
      capability,
      identity.aggregatorId,
      { allow: false, reasons: [resolved.reason] },
      start,
    );
  }
  return checkCapability(req, resolved.actor, capability, now);
}

/**
 * Lists the capabilities a resolved actor holds, for the portal. Never throws.
 *
 * @param req - The request (for its logger).
 * @param actor - The resolved actor.
 * @param now - Clock, for grant expiry. Injectable for tests.
 * @returns The held capabilities; `null` when RBAC is off (no restriction);
 *   an empty list when the engine cannot answer (the API still decides).
 */
export async function listActorCapabilities(
  req: GuardRequest,
  actor: Actor,
  now: number = Date.now(),
): Promise<Capability[] | null> {
  const rt = getRbacRuntime();
  if (!rt) return null;
  const res = await rt.authorizer.listCapabilities({
    actor: actorInput(rt.config, actor),
    candidates: [...CAPABILITIES],
    now,
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
