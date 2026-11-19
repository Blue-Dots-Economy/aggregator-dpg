/**
 * Owner self-add (`@aggregator-dpg/api`): an org owner creates their own
 * coordinator account in an organisation they own, on the same contact and
 * the same IdP login, approved at once.
 *
 * The owner's Keycloak user is never written here: no `aggregator_id`, no
 * decision stamp, no enable or disable. The approval skips Keycloak for a
 * login that also holds an admin account (`services/decisions/coordinator.ts`).
 */

import type { FastifyBaseLogger } from 'fastify';
import { err, ok, type Result } from '@aggregator-dpg/shared-primitives/result';
import type { SelfAddRequest } from '@aggregator-dpg/shared-primitives/user-org';
import type { Actor } from '../auth/actor/index.js';
import { approveCoordinator } from '../decisions/coordinator.js';
import { getIdentityStore } from '../identity-store/index.js';
import { IDP_PROVIDER } from '../idp-admin/provider.js';
import { getIdpAdmin, KC_ATTR } from '../idp-admin/index.js';
import { getNetworkConfig } from '../network-config.js';
import { getOrganisationStore, type Organisation } from '../organisation-store/index.js';
import { getUserStore, type Coordinator } from '../user-store/index.js';
import { aggregatorConsentWriter, createAggregatorWithSlug } from './coordinator-row.js';

/** Why a self-add was refused. */
export interface SelfAddError {
  code:
    | 'NOT_ORG_OWNER'
    | 'ORG_NOT_ELIGIBLE'
    | 'ALREADY_COORDINATOR'
    | 'NO_PROFILE_TYPES'
    | 'OWNER_PHONE_REQUIRED'
    | 'UNAVAILABLE';
  message: string;
}

type SelfAddResult<T> = Result<T, SelfAddError>;

/** Store error codes that mean the owner's contact already has a coordinator row. */
const DUPLICATE_CODES: ReadonlySet<string> = new Set([
  'DUPLICATE',
  'DUPLICATE_EMAIL',
  'DUPLICATE_PHONE',
]);

function refuse(code: SelfAddError['code'], message: string): SelfAddResult<never> {
  return err({ code, message });
}

/**
 * Adds the calling owner as a coordinator of one of their organisations.
 *
 * The caller must be an admin owning `input.org_id`, an active aggregator org
 * other than Default, and must not own the root. A coordinator row of the
 * owner's contact that is not active, in the same org and on the same login,
 * is reactivated; any other existing coordinator account is a conflict.
 *
 * @param actor - The resolved caller.
 * @param subject - The caller's IdP subject.
 * @param input - Org, profile types and the server-stamped consent.
 * @param log - Request logger.
 * @param requestId - Forwarded to Signals as `x-request-id`.
 * @returns The approved coordinator, or why it was refused; never throws.
 */
export async function ownerSelfAdd(
  actor: Actor,
  subject: string,
  input: SelfAddRequest,
  log: FastifyBaseLogger,
  requestId?: string,
): Promise<SelfAddResult<Coordinator>> {
  const slog = log.child({
    operation: 'user.self_add',
    actor_id: actor.userId,
    org_id: input.org_id,
  });
  const out = await selfAdd(actor, subject, input, slog, requestId);
  if (out.success) {
    slog.info({ status: 'success', target_id: out.value.id });
  } else {
    const level = out.error.code === 'UNAVAILABLE' ? 'error' : 'info';
    slog[level]({ status: 'failure', error: out.error.code });
  }
  return out;
}

async function selfAdd(
  actor: Actor,
  subject: string,
  input: SelfAddRequest,
  log: FastifyBaseLogger,
  requestId: string | undefined,
): Promise<SelfAddResult<Coordinator>> {
  if (actor.userType !== 'admin') return refuse('NOT_ORG_OWNER', 'caller is not an org owner');
  const found = await getOrganisationStore().findById(input.org_id);
  if (!found.ok) return refuse('UNAVAILABLE', 'organisation store');
  const org = found.value;
  if (!org || org.ownerUserId !== actor.userId) {
    return refuse('NOT_ORG_OWNER', 'caller does not own the organisation');
  }
  const eligible = orgEligibility(actor, org);
  if (eligible !== null) return refuse('ORG_NOT_ELIGIBLE', eligible);
  const ownerPhone = org.ownerPhone;
  if (!ownerPhone) return refuse('OWNER_PHONE_REQUIRED', 'owner contact has no phone');

  const networkCfg = await getNetworkConfig();
  const serves = [...new Set(input.serves)];
  if (serves.length === 0 || serves.some((d) => !networkCfg.domainIds.includes(d))) {
    return refuse('NO_PROFILE_TYPES', 'serves lists a domain this network does not have');
  }

  const accounts = await getIdentityStore().accountsOf(IDP_PROVIDER, subject);
  if (!accounts.ok) return refuse('UNAVAILABLE', 'identity store');
  if (accounts.value.admin !== actor.userId) {
    return refuse('NOT_ORG_OWNER', 'login is not the owner account');
  }

  const existing = await getUserStore().findByContactEmail(org.ownerEmail);
  if (!existing.ok) return refuse('UNAVAILABLE', 'user store');
  const target: SelfAddTarget = {
    actor,
    subject,
    org,
    serves,
    linkedCoordinator: accounts.value.coordinator,
  };
  const prepared = existing.value
    ? await reactivate(existing.value, target, input.consent, log)
    : await create(target, ownerPhone, input.consent, log);
  if (!prepared.success) return prepared;

  return approve(prepared.value, actor, log, requestId);
}

/** What a self-add writes, once the caller and the org are checked. */
interface SelfAddTarget {
  actor: Actor;
  /** The caller's IdP subject. */
  subject: string;
  org: Organisation;
  /** The profile types to serve, each a network domain id. */
  serves: string[];
  /** The coordinator account already linked to the login, or null. */
  linkedCoordinator: string | null;
}

/**
 * Why the org cannot take a self-add, or null when it can.
 */
function orgEligibility(actor: Actor, org: Organisation): string | null {
  if (actor.orgs.some((o) => o.orgType === 'network_facilitator' && o.relation === 'owner')) {
    return 'caller owns the root';
  }
  if (org.isDefault) return 'the Default org';
  if (org.status !== 'active') return 'organisation is not active';
  return null;
}

/**
 * Puts a non-active self account of the same org back to `pending` with the
 * new profile types and a new consent row, linking the login first when it
 * has none. Refused when the row belongs to another login or Keycloak user.
 */
async function reactivate(
  row: Coordinator,
  target: SelfAddTarget,
  consent: SelfAddRequest['consent'],
  log: FastifyBaseLogger,
): Promise<SelfAddResult<string>> {
  const checked = await checkReactivation(row, target);
  if (!checked.success) return checked;
  // The login is linked before the row changes, so a failed link leaves the row as it was.
  if (!checked.value.linked) {
    const link = await getIdentityStore().link(row.id, IDP_PROVIDER, target.subject, 'coordinator');
    if (!link.ok) return refuse('UNAVAILABLE', `identity link: ${link.error.code}`);
  }
  // The update takes no hook, so the consent row is written just before it.
  const recorded = await recordReactivationConsent(row.id, consent, log);
  if (!recorded.success) return recorded;
  const updated = await getUserStore().update(row.id, {
    serves: target.serves,
    status: 'pending',
    updatedBy: target.actor.userId,
  });
  if (!updated.ok) return refuse('UNAVAILABLE', 'user store update');
  return ok(row.id);
}

/**
 * Checks that a coordinator row may be reactivated for this login.
 *
 * @returns Whether the row's login is already linked, or why it is refused.
 */
async function checkReactivation(
  row: Coordinator,
  { subject, org, linkedCoordinator }: SelfAddTarget,
): Promise<SelfAddResult<{ linked: boolean }>> {
  if (row.parentOrgId !== org.id || row.status === 'active') {
    return refuse('ALREADY_COORDINATOR', 'contact already has a coordinator account');
  }
  if (linkedCoordinator !== null && linkedCoordinator !== row.id) {
    return refuse('ALREADY_COORDINATOR', 'login already has a coordinator account');
  }
  const linked = await getIdentityStore().subjectOf(row.id, IDP_PROVIDER);
  if (!linked.ok) return refuse('UNAVAILABLE', 'identity store');
  if (linked.value !== null && linked.value !== subject) {
    return refuse('ALREADY_COORDINATOR', 'coordinator account belongs to another login');
  }
  // A row registered before self-add has its own Keycloak user; one row never gets two logins.
  const legacy = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, row.id);
  if (!legacy.ok) return refuse('UNAVAILABLE', 'idp lookup');
  if (legacy.value !== null && legacy.value.id !== subject) {
    return refuse('ALREADY_COORDINATOR', 'coordinator account has its own Keycloak user');
  }
  return ok({ linked: linked.value !== null });
}

/** Writes the consent row of a reactivated account. */
async function recordReactivationConsent(
  rowId: string,
  consent: SelfAddRequest['consent'],
  log: FastifyBaseLogger,
): Promise<SelfAddResult<void>> {
  const recordConsent = await aggregatorConsentWriter({ consent, log });
  if (!recordConsent) return refuse('UNAVAILABLE', 'consent config');
  try {
    await recordConsent(undefined, rowId);
  } catch (e) {
    log.error({
      status: 'failure',
      sub_operation: 'consentLedger.recordAggregatorConsent',
      error_type: e instanceof Error ? e.name : typeof e,
      target_id: rowId,
    });
    return refuse('UNAVAILABLE', 'consent ledger');
  }
  return ok(undefined);
}

/**
 * Creates the coordinator row (with its consent, in one transaction), then
 * links the login; a failed link deletes the row again.
 */
async function create(
  { actor, subject, org, serves, linkedCoordinator }: SelfAddTarget,
  ownerPhone: string,
  consent: SelfAddRequest['consent'],
  log: FastifyBaseLogger,
): Promise<SelfAddResult<string>> {
  if (linkedCoordinator !== null) {
    return refuse('ALREADY_COORDINATOR', 'login already has a coordinator account');
  }
  const recordConsent = await aggregatorConsentWriter({ consent, log });
  if (!recordConsent) return refuse('UNAVAILABLE', 'consent config');

  const users = getUserStore();
  const name = org.ownerName ?? org.displayName;
  const created = await createAggregatorWithSlug(users, name, {
    domains: serves,
    contact: { name, email: org.ownerEmail, phone: ownerPhone },
    consent,
    recordConsent,
    orgId: org.id,
    legacyOrgDetails: null,
    locations: [],
    inviteId: null,
    profile: {},
    profileRef: null,
    createdBy: actor.userId,
  });
  if (!created.ok) {
    if (DUPLICATE_CODES.has(created.error.code)) {
      return refuse('ALREADY_COORDINATOR', 'contact already has a coordinator account');
    }
    return refuse('UNAVAILABLE', `user store create: ${created.error.code}`);
  }
  const id = created.value.id;

  const link = await getIdentityStore().link(id, IDP_PROVIDER, subject, 'coordinator');
  if (!link.ok) {
    const removed = await users.deleteById(id);
    log.error({
      status: 'failure',
      sub_operation: 'identityStore.link',
      code: link.error.code,
      target_id: id,
      rolled_back: removed.ok,
    });
    return refuse('UNAVAILABLE', 'identity link');
  }
  return ok(id);
}

/** Runs the approval for the prepared row and returns it. */
async function approve(
  id: string,
  actor: Actor,
  log: FastifyBaseLogger,
  requestId: string | undefined,
): Promise<SelfAddResult<Coordinator>> {
  const outcome = await approveCoordinator({
    aggregatorId: id,
    decidedBy: actor.userId,
    log,
    ...(requestId ? { requestId } : {}),
  });
  switch (outcome.kind) {
    case 'approved':
      break;
    case 'already_decided':
      if (outcome.status !== 'active') {
        return refuse('ALREADY_COORDINATOR', 'coordinator account was decided meanwhile');
      }
      break;
    case 'org_inactive':
      return refuse('ORG_NOT_ELIGIBLE', 'organisation is not active');
    case 'no_profile_types':
      return refuse('NO_PROFILE_TYPES', 'serves no network domain');
    case 'not_found':
    case 'unavailable':
      return refuse('UNAVAILABLE', `approval: ${outcome.kind}`);
  }
  const row = await getUserStore().findById(id);
  if (!row.ok || !row.value) return refuse('UNAVAILABLE', 'user store read');
  return ok(row.value);
}
