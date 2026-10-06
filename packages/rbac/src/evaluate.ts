/**
 * Pure TypeScript evaluation of an access question (`@aggregator-dpg/rbac`).
 *
 * Mirrors `policy/rbac/rbac.rego` rule for rule. The in-memory authorizer uses
 * it, and the shared vectors in `policy/rbac/vectors.json` run against both
 * this function and the Rego policy, so the two cannot drift apart.
 *
 * @module @aggregator-dpg/rbac/evaluate
 */

import { NOT_GRANTABLE } from './catalogue.js';
import type { ActorOrg, Decision, DecisionInput } from './interface.js';

/**
 * Whether the actor can act on the target through organisation `org`.
 *
 * Owners reach the organisation and its subtree: the target's chain must
 * contain the owned organisation, or there must be no target. Members
 * (coordinators) reach only their own tenant inside their own organisation.
 */
function reaches(org: ActorOrg, input: DecisionInput): boolean {
  const target = input.target;
  if (org.relation === 'owner') {
    if (target === undefined) return true;
    return target.orgChain?.includes(org.id) ?? false;
  }
  const tenantOk = target?.tenantUserId === undefined || target.tenantUserId === input.actor.userId;
  const orgOk = target?.orgChain === undefined || target.orgChain[0] === org.id;
  return tenantOk && orgOk;
}

/** Whether personal data is being asked for through the Network Facilitator root. */
function piiBlocked(org: ActorOrg, input: DecisionInput): boolean {
  return input.capability === 'profiles.view_pii' && org.orgType === 'network_facilitator';
}

/** Whether the role holds the capability, or an unexpired grant adds it. */
function roleOrGrant(input: DecisionInput): boolean {
  if (input.actor.roleCapabilities.includes(input.capability)) return true;
  return input.actor.grants.some(
    (g) => g.capability === input.capability && g.expiresAt > input.now,
  );
}

/**
 * Answers one access question without any I/O.
 *
 * @param input - The capability, actor, target and current time.
 * @returns `allow` plus sorted deny reasons (empty when allowed).
 */
export function evaluate(input: DecisionInput): Decision {
  const reasons = new Set<string>();
  const cap = input.capability;
  const reachable = input.actor.orgs.filter((o) => reaches(o, input));
  const roleOk = roleOrGrant(input);

  if (!input.actor.active) reasons.add('inactive');
  if (NOT_GRANTABLE.includes(cap)) reasons.add('not_grantable');
  if (reachable.length === 0) reasons.add('no_reach');
  if (reachable.length > 0 && !roleOk) reasons.add('not_in_role');
  if (
    reachable.length > 0 &&
    !roleOk &&
    input.actor.grants.some((g) => g.capability === cap && g.expiresAt <= input.now)
  ) {
    reasons.add('grant_expired');
  }
  for (const o of reachable) {
    if (!o.capabilities.includes(cap)) reasons.add('not_in_org_set');
    if (piiBlocked(o, input)) reasons.add('pii_blocked_at_root');
  }

  const allow =
    input.actor.active &&
    !NOT_GRANTABLE.includes(cap) &&
    roleOk &&
    reachable.some((o) => o.capabilities.includes(cap) && !piiBlocked(o, input));

  return { allow, reasons: allow ? [] : [...reasons].sort() };
}
