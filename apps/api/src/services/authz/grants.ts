/**
 * Grant and PermissionSet rules (`@aggregator-dpg/api`, RBAC R3).
 *
 * The console routes call these after `requireActor()` has checked the route's
 * capability. They apply the rules that need the target: reach (out of reach =
 * not found), the subset rule (a grant never exceeds the grantee's
 * organisation set), no self-grant, the grant's longest validity, and "only a
 * parent sets a child's PermissionSet". Every change is audited.
 */

import { orgCapabilities, type Capability, type RbacConfig } from '@aggregator-dpg/rbac';
import { getAggregatorStore } from '../aggregator-store/index.js';
import { getAggregatorOrgStore } from '../aggregator-org-store/index.js';
import { isNetworkAdmin, type Actor } from '../auth/actor/index.js';
import { getGrantStore, type PermissionGrant } from '../grant-store/index.js';
import { reachesOrg } from './scope.js';
import { getRbacRuntime } from './runtime.js';

/** Why a grant or PermissionSet change did not happen. */
export type GrantFailure =
  | { kind: 'rbac_off' }
  | { kind: 'not_found' }
  | { kind: 'not_allowed'; reason: string }
  | { kind: 'exceeds_org_set'; capability: Capability }
  | { kind: 'unknown_set' }
  | { kind: 'unavailable'; message: string };

/** Result of a rule-checked operation. */
export type GrantOutcome<T> = { ok: true; value: T } | { ok: false; failure: GrantFailure };

/** A grant the caller may give, from `rbac.yaml`. */
export interface GrantableDef {
  grantKey: string;
  capability: Capability;
  maxDays: number;
}

const fail = <T>(failure: GrantFailure): GrantOutcome<T> => ({ ok: false, failure });
const DAY_MS = 24 * 60 * 60 * 1000;

/** The coordinator `id` within the actor's reach, with its organisation's capabilities. */
async function coordinatorInReach(
  cfg: RbacConfig,
  actor: Actor,
  id: string,
): Promise<GrantOutcome<{ userId: string; orgId: string; orgCaps: Capability[] }>> {
  const row = await getAggregatorStore().findById(id);
  if (!row.ok) return fail({ kind: 'unavailable', message: row.error.message });
  if (!row.value || !row.value.parentOrgId || !reachesOrg(actor, row.value.parentOrgId)) {
    return fail({ kind: 'not_found' });
  }
  const org = await getAggregatorOrgStore().findById(row.value.parentOrgId);
  if (!org.ok) return fail({ kind: 'unavailable', message: org.error.message });
  if (!org.value) return fail({ kind: 'not_found' });
  return {
    ok: true,
    value: {
      userId: row.value.id,
      orgId: org.value.id,
      orgCaps: orgCapabilities(cfg, 'aggregator', org.value.permissionSet),
    },
  };
}

/** The grants `rbac.yaml` offers, limited to what an organisation holds. */
function grantables(cfg: RbacConfig, orgCaps: Capability[]): GrantableDef[] {
  return Object.entries(cfg.grants)
    .map(([grantKey, g]) => ({ grantKey, capability: g.capabilities[0]!, maxDays: g.max_days }))
    .filter((g) => orgCaps.includes(g.capability));
}

/**
 * Lists a coordinator's grants and what may still be granted to it.
 *
 * @param actor - The acting admin.
 * @param userId - The coordinator.
 * @returns Grants (newest first) and grantables.
 */
export async function listUserGrants(
  actor: Actor,
  userId: string,
): Promise<GrantOutcome<{ grants: PermissionGrant[]; grantable: GrantableDef[] }>> {
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const target = await coordinatorInReach(rt.config, actor, userId);
  if (!target.ok) return target;
  const grants = await getGrantStore().listForUser(userId);
  if (!grants.ok) return fail({ kind: 'unavailable', message: grants.error.message });
  return {
    ok: true,
    value: { grants: grants.value, grantable: grantables(rt.config, target.value.orgCaps) },
  };
}

/**
 * Grants `grantKey` to a coordinator, replacing a live grant of the same key.
 *
 * @param actor - The acting admin.
 * @param userId - The coordinator.
 * @param grantKey - A key of `rbac.yaml` `grants`.
 * @param days - Validity; defaults to the grant's `max_days`.
 * @param now - Clock. Injectable for tests.
 * @returns The new grant.
 */
export async function grantToUser(
  actor: Actor,
  userId: string,
  grantKey: string,
  days: number | undefined,
  now: Date = new Date(),
): Promise<GrantOutcome<PermissionGrant>> {
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const def = rt.config.grants[grantKey];
  if (!def) return fail({ kind: 'not_allowed', reason: 'unknown_grant' });
  if (actor.userId === userId) return fail({ kind: 'not_allowed', reason: 'self_grant' });
  const validity = days ?? def.max_days;
  if (validity > def.max_days) return fail({ kind: 'not_allowed', reason: 'days_exceed_max' });

  const target = await coordinatorInReach(rt.config, actor, userId);
  if (!target.ok) return target;
  const capability = def.capabilities[0]!;
  if (!target.value.orgCaps.includes(capability)) {
    return fail({ kind: 'exceeds_org_set', capability });
  }

  const created = await getGrantStore().grant(
    {
      userId,
      grantKey,
      capability,
      grantedBy: actor.userId,
      expiresAt: new Date(now.getTime() + validity * DAY_MS),
    },
    {
      event: 'grant.create',
      actorUserId: actor.userId,
      targetUserId: userId,
      targetOrgId: target.value.orgId,
      details: { grant_key: grantKey, capability, days: validity },
    },
  );
  if (!created.ok) return fail({ kind: 'unavailable', message: created.error.message });
  return { ok: true, value: created.value };
}

/**
 * Revokes a coordinator's live grant of `grantKey`.
 *
 * @param actor - The acting admin.
 * @param userId - The coordinator.
 * @param grantKey - The grant key.
 * @returns Whether a live grant was revoked.
 */
export async function revokeFromUser(
  actor: Actor,
  userId: string,
  grantKey: string,
): Promise<GrantOutcome<boolean>> {
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  const target = await coordinatorInReach(rt.config, actor, userId);
  if (!target.ok) return target;
  const revoked = await getGrantStore().revoke(userId, grantKey, actor.userId, {
    event: 'grant.revoke',
    actorUserId: actor.userId,
    targetUserId: userId,
    targetOrgId: target.value.orgId,
    details: { grant_key: grantKey },
  });
  if (!revoked.ok) return fail({ kind: 'unavailable', message: revoked.error.message });
  return { ok: true, value: revoked.value !== null };
}

/**
 * Sets an organisation's own PermissionSet (or clears it to the org_type
 * default). Only a parent may set a child's set; with no child organisations
 * yet, that is the network admin, the parent of every organisation.
 *
 * @param actor - The acting admin.
 * @param orgId - The organisation.
 * @param setName - A key of `rbac.yaml` `permission_sets`, or null.
 * @returns The set and the capabilities the organisation now holds.
 */
export async function setOrgPermissionSet(
  actor: Actor,
  orgId: string,
  setName: string | null,
): Promise<GrantOutcome<{ id: string; permissionSet: string | null; capabilities: Capability[] }>> {
  const rt = getRbacRuntime();
  if (!rt) return fail({ kind: 'rbac_off' });
  if (setName !== null && !rt.config.permission_sets[setName]) return fail({ kind: 'unknown_set' });
  if (!reachesOrg(actor, orgId)) return fail({ kind: 'not_found' });
  if (!isNetworkAdmin(actor)) return fail({ kind: 'not_allowed', reason: 'parent_only' });

  const orgs = getAggregatorOrgStore();
  const org = await orgs.findById(orgId);
  if (!org.ok) return fail({ kind: 'unavailable', message: org.error.message });
  if (!org.value) return fail({ kind: 'not_found' });

  const updated = await orgs.update(orgId, { permissionSet: setName, updatedBy: actor.userId });
  if (!updated.ok) return fail({ kind: 'unavailable', message: 'org update failed' });
  const audited = await getGrantStore().recordAudit({
    event: 'org.permission_set',
    actorUserId: actor.userId,
    targetOrgId: orgId,
    details: { from: org.value.permissionSet, to: setName },
  });
  if (!audited.ok) return fail({ kind: 'unavailable', message: audited.error.message });
  return {
    ok: true,
    value: {
      id: orgId,
      permissionSet: setName,
      capabilities: orgCapabilities(rt.config, 'aggregator', setName),
    },
  };
}
