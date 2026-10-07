/**
 * Route guard for capability checks (`@aggregator-dpg/api`, RBAC R0).
 *
 * Each route file's auth wrapper calls {@link requirePermission} after the
 * token is verified. It resolves the caller from the database, asks the
 * decision engine, and logs the outcome. In `log` mode a deny is only logged;
 * in `enforce` mode the caller turns `allowed: false` into a 403.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  orgCapabilities,
  roleCapabilities,
  type AuthorizerBase,
  type Capability,
  type Decision,
  type DecisionInput,
  type RbacConfig,
  type Target,
} from '@aggregator-dpg/rbac';
import { getActorResolver, type TokenIdentity } from './actor-resolver/index.js';
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

/**
 * Checks whether the caller holds `capability` on `target`.
 *
 * Never throws. An unknown caller, a database failure or an unreachable
 * engine count as a deny.
 *
 * @param req - The Fastify request (for its logger and route).
 * @param identity - Claims from the verified token.
 * @param capability - The capability the route declares.
 * @param target - What the request touches; omit for the caller's own data.
 * @param now - Clock, for grant expiry. Injectable for tests.
 * @returns Whether to continue, the mode, and the decision.
 */
export async function requirePermission(
  req: GuardRequest,
  identity: TokenIdentity,
  capability: Capability,
  target?: Target,
  now: number = Date.now(),
): Promise<GuardOutcome> {
  const rt = getRbacRuntime();
  if (!rt) return { allowed: true, mode: 'off' };

  const start = Date.now();
  const decision = await decide(rt.config, rt.authorizer, identity, capability, target, now);
  const entry = {
    operation: 'rbac.decide',
    capability,
    route: req.routeOptions?.url,
    method: req.method,
    user_id: identity.aggregatorId,
    mode: rt.mode,
    allow: decision.allow,
    reasons: decision.reasons,
    latency_ms: Date.now() - start,
  };
  if (decision.allow) {
    req.log.debug({ ...entry, status: 'success' });
    return { allowed: true, mode: rt.mode, decision };
  }
  req.log.warn({ ...entry, status: rt.mode === 'enforce' ? 'failure' : 'skipped' });
  return { allowed: rt.mode !== 'enforce', mode: rt.mode, decision };
}

/** Resolves the caller and asks the engine; every failure becomes a deny. */
async function decide(
  cfg: RbacConfig,
  authorizer: AuthorizerBase,
  identity: TokenIdentity,
  capability: Capability,
  target: Target | undefined,
  now: number,
): Promise<Decision> {
  const resolved = await getActorResolver().resolve(identity);
  if (!resolved.ok) return { allow: false, reasons: ['actor_unavailable'] };
  const actor = resolved.value;
  if (!actor) return { allow: false, reasons: ['unknown_actor'] };

  const input: DecisionInput = {
    capability,
    now,
    ...(target ? { target } : {}),
    actor: {
      userId: actor.userId,
      userType: actor.userType,
      active: actor.active,
      roleCapabilities: roleCapabilities(cfg, actor.userType),
      grants: actor.grants,
      orgs: actor.orgs.map((o) => ({
        id: o.id,
        orgType: o.orgType,
        relation: o.relation,
        capabilities: orgCapabilities(cfg, o.orgType, o.permissionSet),
      })),
    },
  };
  const result = await authorizer.decide(input);
  if (!result.success) return { allow: false, reasons: ['engine_unavailable'] };
  return result.value;
}
