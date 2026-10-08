/**
 * Coordinator registration decision (`@aggregator-dpg/api`, user & org Phase 5).
 *
 * The one place a pending coordinator is approved or rejected, shared by the
 * emailed review link (`routes/aggregator-approvals.ts`) and the console
 * (`POST /v1/user/decision/:id`). Callers check who may decide (the link's
 * signed org claim, the console's reach) before calling it.
 *
 * Race-safety (design R3): **reject** is a compare-and-set from `pending`
 * first, then side effects. **Approve** must provision Signals and Keycloak
 * before its compare-and-set (the commit point), so when that compare-and-set
 * loses to a concurrent reject it compensates: the Keycloak user is disabled
 * again and stamped `rejected`. Only the winner mails the applicant.
 */

import type { FastifyBaseLogger } from 'fastify';
import { getMailer } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../../config.js';
import { getAggregatorStore, type Aggregator } from '../aggregator-store/index.js';
import { getAggregatorOrgStore } from '../aggregator-org-store/index.js';
import { getIdpAdmin, KC_ATTR, type IdpUser } from '../idp-admin/index.js';
import { getSignalStackWriter } from '../signalstack.js';
import { getNetworkConfig } from '../network-config.js';
import { renderApplicantApproved, renderApplicantRejected } from '../email-templates/index.js';
import { recordLoginIdentity } from '../identity-store/record.js';

/** What the decider asks for. */
export type Decision = 'approve' | 'reject';

/** `updated_by` value of a decision taken through a signed email link. */
export const LINK_DECIDER = 'admin';

/** The result of a decision, for an HTML page or a JSON response. */
export type DecisionOutcome =
  | { kind: 'decided'; decision: Decision; notified: boolean }
  | {
      kind: 'already_decided';
      status: AggregatorStatus;
      decidedAt: Date;
      /** How it was decided, when the row still says (see {@link deciderOf}). */
      decidedBy: 'link' | 'console' | null;
    }
  | { kind: 'not_found' }
  /** The coordinator's org is no longer active (approve only). */
  | { kind: 'org_inactive' }
  | { kind: 'unavailable'; dependency: 'signalstack' | 'idp' | 'db' };

/** Inputs of {@link decideCoordinator}. */
export interface CoordinatorDecisionInput {
  aggregatorId: string;
  decision: Decision;
  /** Shown to the applicant on reject; never logged or stored. */
  reason?: string;
  /** The deciding admin's user id, or {@link LINK_DECIDER} for an emailed link. */
  decidedBy: string;
  requestId?: string;
  log: FastifyBaseLogger;
}

/** The decision a stored status records, or `null` while pending. */
export function priorDecision(status: AggregatorStatus): 'approved' | 'rejected' | null {
  switch (status) {
    case 'active':
    case 'retired':
      return 'approved';
    case 'inactive':
      return 'rejected';
    default:
      return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How a row was decided, read from its `updated_by`: {@link LINK_DECIDER} is an
 * emailed link, an admin's user id is the console. Anything else (`'self'`,
 * `'system'`, a later write) no longer says, so `null`.
 *
 * @param updatedBy - The row's `updated_by`.
 * @returns `link`, `console`, or `null` when unknown.
 */
export function deciderOf(updatedBy: string | null): 'link' | 'console' | null {
  if (updatedBy === LINK_DECIDER) return 'link';
  return updatedBy && UUID_RE.test(updatedBy) ? 'console' : null;
}

/** The `already_decided` outcome of a decided row. */
function alreadyDecided(row: Aggregator): DecisionOutcome {
  return {
    kind: 'already_decided',
    status: row.status,
    decidedAt: row.status === 'inactive' ? (row.rejectedAt ?? row.updatedAt) : row.updatedAt,
    decidedBy: deciderOf(row.updatedBy),
  };
}

/**
 * Loads a coordinator and its Keycloak user, recording the login link
 * (best effort).
 *
 * @param aggregatorId - Coordinator id.
 * @returns The row and the user, or why they are unavailable.
 */
export async function loadCoordinatorAndUser(
  aggregatorId: string,
): Promise<
  | { ok: true; aggregator: Aggregator; kcUser: IdpUser }
  | { ok: false; reason: 'not_found' | 'db' | 'idp' | 'idp_missing' }
> {
  const stored = await getAggregatorStore().findById(aggregatorId);
  if (!stored.ok) return { ok: false, reason: 'db' };
  if (!stored.value) return { ok: false, reason: 'not_found' };
  const kc = await getIdpAdmin().findByAttribute(KC_ATTR.AGGREGATOR_ID, aggregatorId);
  if (!kc.ok) return { ok: false, reason: 'idp' };
  if (!kc.value) return { ok: false, reason: 'idp_missing' };
  await recordLoginIdentity(aggregatorId, kc.value.id, 'decisions.recordIdentity');
  return { ok: true, aggregator: stored.value, kcUser: kc.value };
}

/** Display name preference: the contact's name, the Keycloak names, the email. */
function applicantName(aggregator: Aggregator, kcUser: IdpUser): string {
  if (aggregator.contact.name) return aggregator.contact.name;
  const parts = [kcUser.firstName, kcUser.lastName].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' ') : kcUser.email;
}

/**
 * Approves or rejects a pending coordinator.
 *
 * @param input - The coordinator, the decision and who takes it.
 * @returns The outcome; never throws.
 */
export async function decideCoordinator(input: CoordinatorDecisionInput): Promise<DecisionOutcome> {
  const log = input.log.child({
    operation: 'coordinator-decision',
    aggregator_id: input.aggregatorId,
  });
  const lookup = await loadCoordinatorAndUser(input.aggregatorId);
  if (!lookup.ok) {
    if (lookup.reason === 'not_found' || lookup.reason === 'idp_missing')
      return { kind: 'not_found' };
    return { kind: 'unavailable', dependency: lookup.reason === 'db' ? 'db' : 'idp' };
  }
  if (priorDecision(lookup.aggregator.status)) return alreadyDecided(lookup.aggregator);
  return input.decision === 'approve'
    ? approve(input, lookup.aggregator, lookup.kcUser, log)
    : reject(input, lookup.aggregator, lookup.kcUser, log);
}

async function approve(
  input: CoordinatorDecisionInput,
  aggregator: Aggregator,
  kcUser: IdpUser,
  log: FastifyBaseLogger,
): Promise<DecisionOutcome> {
  const store = getAggregatorStore();
  const idp = getIdpAdmin();

  // The target org must still be active (a row can sit pending while its org
  // is rejected or retired).
  if (aggregator.parentOrgId) {
    const org = await getAggregatorOrgStore().findById(aggregator.parentOrgId);
    if (!org.ok) return { kind: 'unavailable', dependency: 'db' };
    if (!org.value || org.value.status !== 'active') return { kind: 'org_inactive' };
  }

  // 1. Signals first: until the upsert succeeds the row stays pending and the
  //    Keycloak user disabled; a retry is safe (idempotent on external_id).
  const signalstack = getSignalStackWriter();
  let signalstackOrgId: string | null = null;
  if (signalstack) {
    const started = Date.now();
    const networkCfg = await getNetworkConfig();
    // Every domain the coordinator serves (the console can set several); none
    // known to this network, or `[]`, means all of them.
    const served = aggregator.serves.filter((d) => networkCfg.domainIds.includes(d));
    const domains = served.length > 0 ? served : networkCfg.domainIds;
    const upsert = await signalstack.upsertAggregator({
      external_id: aggregator.id,
      name: aggregator.name,
      slug: aggregator.orgSlug,
      domains,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    if (!upsert.success) {
      log.error({
        status: 'failure',
        sub_operation: 'signalstack.upsertAggregator',
        code: upsert.error.code,
        latency_ms: Date.now() - started,
      });
      return { kind: 'unavailable', dependency: 'signalstack' };
    }
    signalstackOrgId = upsert.value.org_id;
  }

  // 2. Enable the Keycloak user (idempotent); must succeed to sign in.
  const enable = await idp.enableUser(kcUser.id);
  if (!enable.ok) {
    log.error({ status: 'failure', sub_operation: 'idp.enableUser', code: enable.error.code });
    return { kind: 'unavailable', dependency: 'idp' };
  }
  // 3. The gate attribute; soft-fail (the enabled flag already admits them,
  //    and the login-time check repairs it).
  const stamp = await idp.setUserDecision(kcUser.id, 'approved');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
  // 4. Signals org id on Keycloak; soft-fail (login backfill repairs). The
  //    row's copy is written after the commit point, so a losing approval
  //    never touches the row (nor its `updated_by`).
  if (signalstackOrgId) {
    const attr = await idp.setAttributes(kcUser.id, {
      [KC_ATTR.SIGNALSTACK_ORG_ID]: signalstackOrgId,
    });
    if (!attr.ok)
      log.warn({ status: 'failure', sub_operation: 'idp.setAttributes', code: attr.error.code });
  }

  // 5. The commit point: compare-and-set pending → active.
  const cas = await store.approveFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok || cas.value === null) {
    // A database failure, or lost to a concurrent decision. Unless the row is
    // now approved, undo what this approval did in Keycloak, so a user is
    // never enabled while its row is pending, rejected or gone.
    const now = await store.findById(aggregator.id);
    const current = now.ok ? now.value : null;
    if (current?.status !== 'active') await compensate(kcUser.id, log);
    if (signalstackOrgId) {
      // The Signals org stays (upsert is idempotent on external_id: a later
      // approval of the same row reuses it). Ids only.
      log.warn({ status: 'skipped', sub_operation: 'signalstack.orgLeftByLostApproval' });
    }
    if (!cas.ok) {
      log.error({
        status: 'failure',
        sub_operation: 'store.approveFromPending',
        code: cas.error.code,
      });
      return { kind: 'unavailable', dependency: 'db' };
    }
    if (!current) return { kind: 'not_found' };
    return alreadyDecided(current);
  }
  if (signalstackOrgId) {
    const db = await store.updateSignalstackOrgId(aggregator.id, signalstackOrgId, input.decidedBy);
    if (!db.ok)
      log.warn({
        status: 'failure',
        sub_operation: 'store.updateSignalstackOrgId',
        code: db.error.code,
      });
  }

  const mail = renderApplicantApproved({
    contactName: applicantName(aggregator, kcUser),
    association: aggregator.name,
    identifier: aggregator.contact.email,
    signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
  });
  const sent = await getMailer().send({
    to: aggregator.contact.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok)
    log.error({ status: 'failure', sub_operation: 'mailer.send.approved', code: sent.error.code });
  log.info({ status: 'success', decision: 'approve', decided_by: input.decidedBy });
  return { kind: 'decided', decision: 'approve', notified: sent.ok };
}

/** Disables the user and stamps `rejected` again (a lost or failed approval). */
async function compensate(kcUserId: string, log: FastifyBaseLogger): Promise<void> {
  const idp = getIdpAdmin();
  const [disable, back] = await Promise.all([
    idp.disableUser(kcUserId),
    idp.setUserDecision(kcUserId, 'rejected'),
  ]);
  if (!disable.ok || !back.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'compensate.lostApproval',
      disable: disable.ok ? 'ok' : disable.error.code,
      stamp: back.ok ? 'ok' : back.error.code,
    });
  }
}

async function reject(
  input: CoordinatorDecisionInput,
  aggregator: Aggregator,
  kcUser: IdpUser,
  log: FastifyBaseLogger,
): Promise<DecisionOutcome> {
  const store = getAggregatorStore();
  // Compare-and-set first (write-once rejected_at): only the winner continues.
  const cas = await store.rejectFromPending(aggregator.id, input.decidedBy);
  if (!cas.ok) {
    log.error({
      status: 'failure',
      sub_operation: 'store.rejectFromPending',
      code: cas.error.code,
    });
    return { kind: 'unavailable', dependency: 'db' };
  }
  if (cas.value === null) {
    const now = await store.findById(aggregator.id);
    if (!now.ok) return { kind: 'unavailable', dependency: 'db' };
    if (!now.value) return { kind: 'not_found' };
    return alreadyDecided(now.value);
  }
  const stamp = await getIdpAdmin().setUserDecision(kcUser.id, 'rejected');
  if (!stamp.ok) {
    log.warn({ status: 'failure', sub_operation: 'idp.setUserDecision', code: stamp.error.code });
  }
  const mail = renderApplicantRejected({
    contactName: applicantName(aggregator, kcUser),
    association: aggregator.name,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  const sent = await getMailer().send({
    to: aggregator.contact.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok)
    log.error({ status: 'failure', sub_operation: 'mailer.send.rejected', code: sent.error.code });
  // The reason is free text: never logged (design C17).
  log.info({ status: 'success', decision: 'reject', decided_by: input.decidedBy });
  return { kind: 'decided', decision: 'reject', notified: sent.ok };
}
