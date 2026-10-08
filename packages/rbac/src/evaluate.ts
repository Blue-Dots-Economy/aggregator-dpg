/**
 * Pure TypeScript evaluation of an access question (`@aggregator-dpg/rbac`).
 *
 * Mirrors `policy/rbac/rbac.rego` rule for rule. The in-memory authorizer uses
 * it, and the shared vectors in `policy/rbac/vectors.json` run against both
 * this function and the Rego policy, so the two cannot drift apart.
 *
 * The policy answers whether the actor holds a capability. Reach (which
 * targets) is decided outside it, by the API's scope checks (design D3).
 *
 * @module @aggregator-dpg/rbac/evaluate
 */

import { NOT_GRANTABLE } from './catalogue.js';
import type { ActorOrg, Decision, DecisionInput } from './interface.js';

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
 * Allowed when the actor is active, the capability is grantable, the role (or
 * an unexpired grant) holds it, and at least one of the actor's organisations
 * holds it in its PermissionSet — never personal data through the root.
 *
 * @param input - The capability, actor and current time.
 * @returns `allow` plus sorted deny reasons (empty when allowed).
 */
export function evaluate(input: DecisionInput): Decision {
  const reasons = new Set<string>();
  const cap = input.capability;
  const orgs = input.actor.orgs;
  const roleOk = roleOrGrant(input);
  const holding = orgs.filter((o) => o.capabilities.includes(cap));

  if (!input.actor.active) reasons.add('inactive');
  if (NOT_GRANTABLE.includes(cap)) reasons.add('not_grantable');
  if (orgs.length === 0) reasons.add('no_organisation');
  if (!roleOk) reasons.add('not_in_role');
  if (!roleOk && input.actor.grants.some((g) => g.capability === cap && g.expiresAt <= input.now)) {
    reasons.add('grant_expired');
  }
  if (orgs.length > 0 && holding.length === 0) reasons.add('not_in_org_set');
  if (holding.length > 0 && holding.every((o) => piiBlocked(o, input))) {
    reasons.add('pii_blocked_at_root');
  }

  const allow =
    input.actor.active &&
    !NOT_GRANTABLE.includes(cap) &&
    roleOk &&
    holding.some((o) => !piiBlocked(o, input));

  return { allow, reasons: allow ? [] : [...reasons].sort() };
}
