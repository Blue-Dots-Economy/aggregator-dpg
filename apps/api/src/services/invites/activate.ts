/**
 * Activates an invited account after its first email sign-in (`@aggregator-dpg/api`).
 *
 * An invite accept leaves the coordinator or the org `pending`, with a
 * Keycloak user that is enabled, unverified and `decision_made = invited`.
 * Signing in with an email code marks the email verified, which proves the
 * invitee owns the invited address. Activation then approves the account and
 * tells the inviting org's owner that the invitee joined.
 */

import type { FastifyBaseLogger } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import { getIdpAdmin, KC_ATTR, type IdpUser } from '../idp-admin/index.js';
import { getUserStore, type Coordinator } from '../user-store/index.js';
import { getOrganisationStore, type Organisation } from '../organisation-store/index.js';
import { approveCoordinator } from '../decisions/coordinator.js';
import { approveOrg, grantOwnerAccess, type OwnerAccessResult } from '../decisions/org.js';
import { renderCoordinatorJoined, renderOrgJoined } from '../email-templates/index.js';
import { config } from '../../config.js';

/** Which account an activation is about. */
export type ActivatedAccount = 'coordinator' | 'org_owner';

/** Result of {@link activateInvitedAccount}. */
export type ActivateOutcome =
  | { kind: 'activated' | 'already_active'; account: ActivatedAccount }
  /** No coordinator or org is linked to this login. */
  | { kind: 'not_found' }
  /** The account was not created from an invite, or was decided another way. */
  | { kind: 'not_invited' }
  /** The login has not verified its email yet. */
  | { kind: 'email_not_verified' }
  /** The org the invitee joins is no longer active. */
  | { kind: 'org_inactive' }
  /** The invited coordinator serves no profile type of the network. */
  | { kind: 'no_profile_types' }
  | { kind: 'unavailable'; dependency: 'db' | 'idp' | 'signalstack' };

/** The `decision_made` value an invite accept writes. */
const INVITED = 'invited';

/** Where an owner manages their team and organisations. */
function consoleUrl(): string {
  return `${config.PUBLIC_PORTAL_URL}/console`;
}

/** Whether the login is an unverified-until-now invitee. */
function invitedAndVerified(kc: IdpUser): 'ok' | 'not_invited' | 'email_not_verified' {
  if (kc.attributes?.[KC_ATTR.DECISION_MADE]?.[0] !== INVITED) return 'not_invited';
  return kc.emailVerified === true ? 'ok' : 'email_not_verified';
}

/**
 * Finds an org by id, the root included.
 *
 * @returns The org, `null` when there is none, or `undefined` on a store error.
 */
async function orgOrRoot(id: string): Promise<Organisation | null | undefined> {
  const store = getOrganisationStore();
  const found = await store.findById(id);
  if (!found.ok) return undefined;
  if (found.value) return found.value;
  const root = await store.findRoot();
  if (!root.ok) return undefined;
  return root.value?.id === id ? root.value : null;
}

/** Logs why an activation stopped and returns that outcome. */
function refused(
  log: FastifyBaseLogger,
  outcome: ActivateOutcome,
  detail: Record<string, unknown>,
): ActivateOutcome {
  log.warn({ status: 'failure', outcome: outcome.kind, ...detail }, 'invite activation stopped');
  return outcome;
}

/** Mails the inviting org's owner; a failed send is logged, not raised. */
async function mailInviter(
  to: string,
  mail: { subject: string; html: string; text: string },
  log: FastifyBaseLogger,
): Promise<void> {
  const sent = await getMailer().send({ to, ...mail });
  if (!sent.ok) {
    log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.inviteJoined',
      code: sent.error.code,
    });
  }
}

/** Activates an invited coordinator. */
async function activateCoordinator(
  row: Coordinator,
  kc: IdpUser,
  log: FastifyBaseLogger,
  requestId: string,
): Promise<ActivateOutcome> {
  if (row.status === 'active') return { kind: 'already_active', account: 'coordinator' };
  if (row.status !== 'pending' || !row.parentOrgId) return { kind: 'not_invited' };
  const check = invitedAndVerified(kc);
  if (check !== 'ok') return { kind: check };
  const org = await orgOrRoot(row.parentOrgId);
  if (org === undefined) {
    return refused(
      log,
      { kind: 'unavailable', dependency: 'db' },
      { sub_operation: 'orgStore.findById', org_id: row.parentOrgId },
    );
  }
  if (org === null) return { kind: 'org_inactive' };

  const outcome = await approveCoordinator({
    aggregatorId: row.id,
    decidedBy: `invite:${org.ownerUserId}`,
    requestId,
    log,
  });
  switch (outcome.kind) {
    case 'approved':
      break;
    case 'already_decided':
      return outcome.status === 'active'
        ? { kind: 'already_active', account: 'coordinator' }
        : { kind: 'not_invited' };
    case 'not_found':
      return { kind: 'not_found' };
    case 'org_inactive':
      return { kind: 'org_inactive' };
    case 'no_profile_types':
      return refused(log, outcome, { aggregator_id: row.id });
    case 'unavailable':
      return outcome;
  }
  await mailInviter(
    org.ownerEmail,
    renderCoordinatorJoined({
      joinerName: row.contact.name ?? row.contact.email,
      joinerEmail: row.contact.email,
      orgName: org.displayName,
      consoleUrl: consoleUrl(),
    }),
    log,
  );
  return { kind: 'activated', account: 'coordinator' };
}

/** The per-step results of an owner-access grant, for the log. */
function stepsOf(access: OwnerAccessResult): Record<string, string> {
  return { enable: access.enable, role: access.role, group: access.group };
}

/** Marks the owner approved so later sign-ins skip activation; soft-fails, a retry repeats it. */
async function stampApproved(kc: IdpUser, log: FastifyBaseLogger): Promise<void> {
  const stamp = await getIdpAdmin().setUserDecision(kc.id, 'approved');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
}

/**
 * Grants owner access again for an org already active whose owner is still marked invited,
 * so an earlier partly failed grant is completed on the next sign-in.
 */
async function repairOwnerAccess(
  org: Organisation,
  kc: IdpUser,
  log: FastifyBaseLogger,
): Promise<ActivateOutcome> {
  if (kc.attributes?.[KC_ATTR.DECISION_MADE]?.[0] !== INVITED) {
    return { kind: 'already_active', account: 'org_owner' };
  }
  const access = await grantOwnerAccess(org, log);
  if (access.status === 'partial') {
    return refused(
      log,
      { kind: 'unavailable', dependency: 'idp' },
      { sub_operation: 'grantOwnerAccess', org_id: org.id, ...stepsOf(access) },
    );
  }
  await stampApproved(kc, log);
  return { kind: 'already_active', account: 'org_owner' };
}

/** Activates an invited org and its owner. */
async function activateOrg(
  org: Organisation,
  kc: IdpUser,
  log: FastifyBaseLogger,
): Promise<ActivateOutcome> {
  if (org.status === 'active') return repairOwnerAccess(org, kc, log);
  if (org.status !== 'pending' || !org.parentId) return { kind: 'not_invited' };
  const check = invitedAndVerified(kc);
  if (check !== 'ok') return { kind: check };
  const parent = await orgOrRoot(org.parentId);
  if (parent === undefined) {
    return refused(
      log,
      { kind: 'unavailable', dependency: 'db' },
      { sub_operation: 'orgStore.findById', org_id: org.parentId },
    );
  }
  if (parent === null) return { kind: 'org_inactive' };

  const outcome = await approveOrg({
    orgId: org.id,
    decidedBy: `invite:${parent.ownerUserId}`,
    log,
  });
  if (outcome.kind === 'already_decided') {
    return outcome.status === 'active'
      ? { kind: 'already_active', account: 'org_owner' }
      : { kind: 'not_invited' };
  }
  if (outcome.kind !== 'approved') return outcome;
  if (outcome.ownerAccess.status === 'partial') {
    return refused(
      log,
      { kind: 'unavailable', dependency: 'idp' },
      { sub_operation: 'grantOwnerAccess', org_id: org.id, ...stepsOf(outcome.ownerAccess) },
    );
  }
  await stampApproved(kc, log);
  await mailInviter(
    parent.ownerEmail,
    renderOrgJoined({
      orgName: org.displayName,
      ownerEmail: org.ownerEmail,
      parentName: parent.displayName,
      consoleUrl: consoleUrl(),
    }),
    log,
  );
  return { kind: 'activated', account: 'org_owner' };
}

/**
 * Activates the invited account a login belongs to, once its email is verified.
 *
 * @param subject - The Keycloak user id of the signed-in caller (token `sub`).
 * @param log - Request logger.
 * @param requestId - Propagated to Signals.
 * @returns The outcome; never throws.
 */
export async function activateInvitedAccount(
  subject: string,
  log: FastifyBaseLogger,
  requestId: string,
): Promise<ActivateOutcome> {
  const scoped = log.child({ operation: 'invite.activate' });
  const kc = await getIdpAdmin().findById(subject);
  if (!kc.ok) {
    return refused(
      scoped,
      { kind: 'unavailable', dependency: 'idp' },
      { sub_operation: 'idp.findById', code: kc.error.code },
    );
  }
  if (!kc.value) return refused(scoped, { kind: 'not_found' }, { reason: 'no_idp_user' });

  const aggregatorId = kc.value.attributes?.[KC_ATTR.AGGREGATOR_ID]?.[0];
  if (aggregatorId) {
    const row = await getUserStore().findById(aggregatorId);
    if (!row.ok) {
      return refused(
        scoped,
        { kind: 'unavailable', dependency: 'db' },
        { sub_operation: 'userStore.findById', code: row.error.code },
      );
    }
    if (!row.value) {
      return refused(
        scoped,
        { kind: 'not_found' },
        { reason: 'no_coordinator', aggregator_id: aggregatorId },
      );
    }
    return activateCoordinator(row.value, kc.value, scoped, requestId);
  }

  const owned = await getOrganisationStore().findByOwnerEmail(kc.value.email.toLowerCase());
  if (!owned.ok) {
    return refused(
      scoped,
      { kind: 'unavailable', dependency: 'db' },
      { sub_operation: 'orgStore.findByOwnerEmail', code: owned.error.code },
    );
  }
  if (owned.value?.ownerKcSub !== subject) {
    return refused(scoped, { kind: 'not_found' }, { reason: 'no_owned_org' });
  }
  return activateOrg(owned.value, kc.value, scoped);
}
