/**
 * Organisation approval and owner access (`@aggregator-dpg/api`).
 *
 * `approveOrg` is the one place a pending aggregator org becomes active, run
 * by invite activation. It is a compare-and-set from `pending` first; only
 * the winner grants owner access.
 *
 * `grantOwnerAccess` lets an owner sign in: enables their Keycloak user,
 * grants the `org_owner` realm role and adds the org's group. It runs at
 * approval, from "repair access", and in the `enable-owners` tool step. Idempotent.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { getOrganisationStore, type Organisation } from '../organisation-store/index.js';
import { getIdpAdmin, OWNER_REALM_ROLE } from '../idp-admin/index.js';
import { requestTokenRolesSync } from '../authz/token-roles.js';

/** The realm role the portal gate admits owners by. */
export const OWNER_ROLE = OWNER_REALM_ROLE;

/** The result of an org approval. */
export type OrgApprovalOutcome =
  | { kind: 'approved'; ownerAccess: OwnerAccessResult }
  | { kind: 'already_decided'; status: AggregatorStatus }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; dependency: 'db' };

/** Inputs of {@link approveOrg}. */
export interface OrgApprovalInput {
  orgId: string;
  /** Written to `updated_by`: `invite:<inviter id>`. */
  decidedBy: string;
  log: FastifyBaseLogger;
}

/** Outcome of one owner-access provisioning step. */
export type OwnerAccessStepResult = 'ok' | 'failed' | 'skipped';

/** What {@link grantOwnerAccess} achieved; any `failed` step can be retried. */
export interface OwnerAccessResult {
  /** `no_login`: the owner has no recorded Keycloak user. */
  status: 'granted' | 'partial' | 'no_login';
  enable: OwnerAccessStepResult;
  role: OwnerAccessStepResult;
  group: OwnerAccessStepResult;
}

/**
 * Lets an org's owner sign in: enables their Keycloak user, assigns the
 * `org_owner` role, adds them to the org's group. Each step is attempted even
 * when an earlier one fails; failures are logged (codes only).
 *
 * @param org - The org (its `ownerKcSub` and `kcGroupId`).
 * @param log - Logger.
 * @returns Per-step results.
 */
export async function grantOwnerAccess( // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  org: Organisation,
  log: FastifyBaseLogger,
): Promise<OwnerAccessResult> {
  const sub = org.ownerKcSub;
  if (!sub) {
    log.warn({
      operation: 'owner-access.grant',
      status: 'skipped',
      org_id: org.id,
      reason: 'no_login',
    });
    return { status: 'no_login', enable: 'skipped', role: 'skipped', group: 'skipped' };
  }
  const idp = getIdpAdmin();
  const enable = await idp.enableUser(sub);
  const role = await idp.assignRealmRole(sub, OWNER_ROLE);
  const group = org.kcGroupId ? await idp.addUserToGroup(sub, org.kcGroupId) : null;
  let groupStatus: OwnerAccessStepResult;
  if (group === null) {
    groupStatus = 'skipped';
  } else {
    groupStatus = group.ok ? 'ok' : 'failed';
  }
  const result: OwnerAccessResult = {
    status: 'granted',
    enable: enable.ok ? 'ok' : 'failed',
    role: role.ok ? 'ok' : 'failed',
    group: groupStatus,
  };
  if (result.enable === 'failed' || result.role === 'failed' || result.group === 'failed') {
    result.status = 'partial';
    let groupDetail: string;
    if (group === null) {
      groupDetail = 'skipped';
    } else {
      groupDetail = group.ok ? 'ok' : group.error.code;
    }
    log.warn({
      operation: 'owner-access.grant',
      status: 'failure',
      org_id: org.id,
      enable: enable.ok ? 'ok' : enable.error.code,
      role: role.ok ? 'ok' : role.error.code,
      group: groupDetail,
    });
  }
  return result;
}

/**
 * Approves a pending aggregator org and gives its owner sign-in access.
 *
 * @param input - The org and who approves it.
 * @returns The outcome; never throws.
 */
export async function approveOrg(input: OrgApprovalInput): Promise<OrgApprovalOutcome> {
  const log = input.log.child({ operation: 'org-approval', org_id: input.orgId });
  const store = getOrganisationStore();
  const found = await store.findById(input.orgId);
  if (!found.ok) return { kind: 'unavailable', dependency: 'db' };
  if (!found.value || found.value.isDefault) return { kind: 'not_found' };
  const org = found.value;
  if (org.status !== 'pending') return { kind: 'already_decided', status: org.status };

  const cas = await store.approve(org.id, input.decidedBy);
  if (!cas.ok) {
    log.error({ status: 'failure', sub_operation: 'store.approve', code: cas.error.code });
    return { kind: 'unavailable', dependency: 'db' };
  }
  if (cas.value === null) {
    const now = await store.findById(org.id);
    if (!now.ok) return { kind: 'unavailable', dependency: 'db' };
    if (!now.value) return { kind: 'not_found' };
    return { kind: 'already_decided', status: now.value.status };
  }

  const ownerAccess = await grantOwnerAccess(org, log);
  requestTokenRolesSync([org.ownerUserId], 'org_approved');
  log.info({
    status: 'success',
    decided_by: input.decidedBy,
    owner_access: ownerAccess.status,
  });
  return { kind: 'approved', ownerAccess };
}
