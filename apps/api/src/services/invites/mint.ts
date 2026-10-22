/**
 * Coordinator-invite minting (`@aggregator-dpg/api`).
 *
 * Shared by `POST /admin/v1/invites` and `POST /v1/user/create`. Per
 * recipient: validate, de-duplicate, then mint or refresh a 14-day invite and
 * mail it. If the address already has an account:
 *
 *   - a coordinator of this org: nothing is mailed; reported as `existing`;
 *   - any other account: a "you already have an account" mail is sent and an
 *     invite row is still kept, so the counts look the same as for a fresh
 *     address and cannot be used to probe other orgs' members.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { MailerAdapter } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { config } from '../../config.js';
import { getUserStore } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import type { getRegistrationInvitesStore } from '../registration-invites-store/index.js';
import { mintInviteToken } from '../invite-token.js';
import { renderCoordinatorInvite, renderInviteExistingAccount } from '../email-templates/index.js';

/** One invite recipient. */
export interface InviteRecipient {
  email: string;
  name?: string | undefined;
}

/** Result of minting a batch of recipients. */
export interface MintSummary {
  sent: number;
  resent: number;
  invalid: Array<{ email: string; reason: string }>;
  /** Addresses already registered as coordinators of this org (nothing mailed). */
  existing: Array<{ email: string; status: AggregatorStatus }>;
}

/** Inputs for {@link mintInviteBatch}. */
export interface MintBatchDeps {
  invites: ReturnType<typeof getRegistrationInvitesStore>;
  mailer: MailerAdapter;
  orgId: string;
  orgName: string;
  /** The inviting org's contact (owner email) — sender identity in the email. */
  inviterEmail: string;
  recipients: InviteRecipient[];
  ttlSec: number;
  /** Audit value stored on the invite row (`grant:<org>` or the admin's user id). */
  createdBy: string;
  log: FastifyBaseLogger;
}

// Simple email check to reject obvious garbage. Linear: no catastrophic backtracking.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Builds the coordinator registration URL carrying an invite token. */
function inviteUrl(token: string): string {
  return `${config.PUBLIC_PORTAL_URL}/register/coordinator?invite=${encodeURIComponent(token)}`;
}

/** Formats an absolute expiry date for the invite email (e.g. "15 Sep 2026"). */
function formatExpiryDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** One recipient outcome after resolving its invite row. */
interface ResolvedInvite {
  jti: string;
  refreshed: boolean;
}

/**
 * Resolves the invite row for one (org, email): refreshes a pending invite or
 * creates one (refreshing on a unique-key race). Returns the `jti` and whether
 * it was a refresh, or `null` on a store error.
 */
async function resolveInviteJti(
  invites: MintBatchDeps['invites'],
  orgId: string,
  email: string,
  expiresAt: Date,
  createdBy: string,
): Promise<ResolvedInvite | null> {
  const existing = await invites.findPendingByOrgAndEmail(orgId, email);
  if (!existing.ok) return null;
  if (existing.value) {
    const refreshed = await invites.refresh(existing.value.jti, { expiresAt, createdBy });
    return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
  }
  const created = await invites.create({ parentOrgId: orgId, email, expiresAt, createdBy });
  if (created.ok) return { jti: created.value.jti, refreshed: false };
  if (created.error.code === 'DUPLICATE_PENDING') {
    const again = await invites.findPendingByOrgAndEmail(orgId, email);
    if (again.ok && again.value) {
      const refreshed = await invites.refresh(again.value.jti, { expiresAt, createdBy });
      return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
    }
  }
  return null;
}

/** Who already holds an address, as far as inviting is concerned. */
type AccountMatch =
  | { kind: 'none' }
  | { kind: 'own_coordinator'; status: AggregatorStatus }
  | { kind: 'other_account' }
  | { kind: 'error' };

/**
 * Looks the address up among coordinators, org owners and the root / Default owners.
 */
async function accountFor(email: string, orgId: string): Promise<AccountMatch> {
  const coordinator = await getUserStore().findByContactEmail(email);
  if (!coordinator.ok) return { kind: 'error' };
  if (coordinator.value) {
    return coordinator.value.parentOrgId === orgId
      ? { kind: 'own_coordinator', status: coordinator.value.status }
      : { kind: 'other_account' };
  }
  const orgStore = getOrganisationStore();
  const [owner, root, def] = await Promise.all([
    orgStore.findByOwnerEmail(email),
    orgStore.findRoot(),
    orgStore.findDefault(),
  ]);
  if (!owner.ok || !root.ok || !def.ok) return { kind: 'error' };
  if (owner.value || root.value?.ownerEmail === email || def.value?.ownerEmail === email) {
    return { kind: 'other_account' };
  }
  return { kind: 'none' };
}

/**
 * Mints or refreshes and emails an invite per recipient. Invalid and duplicate
 * addresses are bucketed; existing accounts are handled as in the module doc.
 * A failed email is logged and still counted as sent.
 *
 * @param deps - Store, mailer, org, recipients, and token settings.
 * @returns Per-batch counts, the invalid list and own-org existing members.
 */
export async function mintInviteBatch(deps: MintBatchDeps): Promise<MintSummary> {
  // NOSONAR typescript:S3776 — inherently branchy decision flow; splitting would obscure it
  const { invites, mailer, orgId, orgName, inviterEmail, recipients, ttlSec, createdBy, log } =
    deps;
  const summary: MintSummary = { sent: 0, resent: 0, invalid: [], existing: [] };
  // De-duplicate within the batch.
  const seen = new Set<string>();

  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'invalid_email' });
      continue;
    }
    if (seen.has(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(email);

    const account = await accountFor(email, orgId); // NOSONAR typescript:S9382 — sequential by design
    if (account.kind === 'error') {
      summary.invalid.push({ email: recipient.email, reason: 'store_error' });
      continue;
    }
    if (account.kind === 'own_coordinator') {
      summary.existing.push({ email: recipient.email, status: account.status });
      continue;
    }
    if (account.kind === 'other_account') {
      // Keep an invite row so counts match a fresh address (no account oracle).
      const expiresAt = new Date(Date.now() + ttlSec * 1000);
      const kept = await resolveInviteJti(invites, orgId, email, expiresAt, createdBy); // NOSONAR typescript:S9382 — sequential by design
      if (!kept) {
        summary.invalid.push({ email: recipient.email, reason: 'store_error' });
        continue;
      }
      const mail = renderInviteExistingAccount({
        orgName,
        signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
      });
      const send = await mailer.send({
        // NOSONAR typescript:S9382 — sequential by design
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      if (!send.ok) {
        log.warn({
          status: 'failure',
          sub_operation: 'mailer.send.inviteExistingAccount',
          code: send.error.code,
        });
      }
      if (kept.refreshed) summary.resent += 1;
      else summary.sent += 1;
      continue;
    }

    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const resolved = await resolveInviteJti(invites, orgId, email, expiresAt, createdBy); // NOSONAR typescript:S9382 — sequential by design
    if (!resolved) {
      summary.invalid.push({ email: recipient.email, reason: 'store_error' });
      continue;
    }

    const { token } = await mintInviteToken({ jti: resolved.jti, org: orgId, email }); // NOSONAR typescript:S9382 — sequential by design
    const mail = renderCoordinatorInvite({
      orgName,
      inviterEmail,
      inviteUrl: inviteUrl(token),
      expiresOn: formatExpiryDate(expiresAt),
      ...(recipient.name ? { recipientName: recipient.name } : {}),
    });
    const send = await mailer.send({
      // NOSONAR typescript:S9382 — sequential by design
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    if (!send.ok) {
      log.warn(
        {
          status: 'failure',
          sub_operation: 'mailer.send.coordinatorInvite',
          code: send.error.code,
        },
        'coordinator-invite email delivery failed (invite minted)',
      );
    }
    if (resolved.refreshed) summary.resent += 1;
    else summary.sent += 1;
  }
  return summary;
}
