/**
 * Invite minting for coordinators and child organisations (`@aggregator-dpg/api`).
 *
 * Shared by `POST /admin/v1/invites`, `POST /v1/user/create`,
 * `POST /v1/user/invite` and `POST /v1/org/invite`. Per recipient: validate,
 * de-duplicate, then mint or refresh a 14-day invite and mail it. If the
 * address already has an account:
 *
 *   - a coordinator of this org, on a coordinator invite: nothing is mailed;
 *     reported as `existing`;
 *   - any other account: a "you already have an account" mail is sent and an
 *     invite row is still kept, so the counts look the same as for a fresh
 *     address and cannot be used to probe other orgs' members.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { MailerAdapter } from '@aggregator-dpg/mailer';
import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';
import { isEmailAddress } from '@aggregator-dpg/shared-primitives/phone';
import { config } from '../../config.js';
import { getUserStore } from '../user-store/index.js';
import { getOrganisationStore } from '../organisation-store/index.js';
import type {
  getRegistrationInvitesStore,
  InviteRole,
} from '../registration-invites-store/index.js';
import { mintInviteToken } from '../invite-token.js';
import {
  renderCoordinatorInvite,
  renderInviteExistingAccount,
  renderOrgInvite,
} from '../email-templates/index.js';

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
  /** `coordinator` invites into `orgId`; `org_owner` invites a child org of `orgId`. */
  role: InviteRole;
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

/** Registration page for each invite role. */
const REGISTER_PATH: Readonly<Record<InviteRole, string>> = {
  coordinator: '/register/coordinator',
  org_owner: '/register/owner',
};

/** Builds the registration URL carrying an invite token. */
function inviteUrl(token: string, role: InviteRole): string {
  return `${config.PUBLIC_PORTAL_URL}${REGISTER_PATH[role]}?invite=${encodeURIComponent(token)}`;
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
 * Resolves the invite row for one (org, role, email): refreshes a pending invite or
 * creates one (refreshing on a unique-key race). Returns the `jti` and whether
 * it was a refresh, or `null` on a store error.
 */
async function resolveInviteJti(
  ctx: BatchContext,
  email: string,
  expiresAt: Date,
): Promise<ResolvedInvite | null> {
  const { invites, orgId, role, createdBy } = ctx;
  const existing = await invites.findPendingByOrgAndEmail(orgId, role, email);
  if (!existing.ok) return null;
  if (existing.value) {
    const refreshed = await invites.refresh(existing.value.jti, { expiresAt, createdBy });
    return refreshed.ok ? { jti: refreshed.value.jti, refreshed: true } : null;
  }
  const created = await invites.create({ parentOrgId: orgId, role, email, expiresAt, createdBy });
  if (created.ok) return { jti: created.value.jti, refreshed: false };
  if (created.error.code === 'DUPLICATE_PENDING') {
    const again = await invites.findPendingByOrgAndEmail(orgId, role, email);
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
async function accountFor(email: string, orgId: string, role: InviteRole): Promise<AccountMatch> {
  const coordinator = await getUserStore().findByContactEmail(email);
  if (!coordinator.ok) return { kind: 'error' };
  if (coordinator.value) {
    return role === 'coordinator' && coordinator.value.parentOrgId === orgId
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

/** Batch-wide inputs shared by every recipient. */
type BatchContext = Omit<MintBatchDeps, 'recipients'>;

/** What happened to one recipient that reached the mailer. */
type SendOutcome = 'sent' | 'resent' | 'store_error';

/**
 * Keeps an invite row for an address that already has another account and
 * mails it a "you already have an account" note, so counts match a fresh
 * address (no account oracle).
 */
async function inviteExistingAccount(ctx: BatchContext, email: string): Promise<SendOutcome> {
  const expiresAt = new Date(Date.now() + ctx.ttlSec * 1000);
  const kept = await resolveInviteJti(ctx, email, expiresAt);
  if (!kept) return 'store_error';
  const mail = renderInviteExistingAccount({
    orgName: ctx.orgName,
    signInUrl: `${config.PUBLIC_PORTAL_URL}/login`,
  });
  const send = await ctx.mailer.send({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!send.ok) {
    ctx.log.warn({
      status: 'failure',
      sub_operation: 'mailer.send.inviteExistingAccount',
      code: send.error.code,
    });
  }
  return kept.refreshed ? 'resent' : 'sent';
}

/** Mints or refreshes an invite for a new address and mails the registration link. */
async function inviteNewAddress(
  ctx: BatchContext,
  email: string,
  recipientName: string | undefined,
): Promise<SendOutcome> {
  const expiresAt = new Date(Date.now() + ctx.ttlSec * 1000);
  const resolved = await resolveInviteJti(ctx, email, expiresAt);
  if (!resolved) return 'store_error';
  const { token } = await mintInviteToken({
    jti: resolved.jti,
    role: ctx.role,
    org: ctx.orgId,
    email,
  });
  const vars = {
    orgName: ctx.orgName,
    inviterEmail: ctx.inviterEmail,
    inviteUrl: inviteUrl(token, ctx.role),
    expiresOn: formatExpiryDate(expiresAt),
    ...(recipientName ? { recipientName } : {}),
  };
  const mail = ctx.role === 'org_owner' ? renderOrgInvite(vars) : renderCoordinatorInvite(vars);
  const send = await ctx.mailer.send({
    to: email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!send.ok) {
    ctx.log.warn(
      {
        status: 'failure',
        sub_operation: 'mailer.send.invite',
        role: ctx.role,
        code: send.error.code,
      },
      'invite email delivery failed (invite minted)',
    );
  }
  return resolved.refreshed ? 'resent' : 'sent';
}

/** Adds one recipient's outcome to the batch summary. */
function tally(summary: MintSummary, email: string, outcome: SendOutcome): void {
  if (outcome === 'store_error') summary.invalid.push({ email, reason: 'store_error' });
  else summary[outcome] += 1;
}

/**
 * Mints or refreshes and emails an invite per recipient. Invalid and duplicate
 * addresses are bucketed; existing accounts are handled as in the module doc.
 * A failed email is logged and still counted as sent. Recipients are handled
 * one at a time, in order.
 *
 * @param deps - Store, mailer, org, recipients, and token settings.
 * @returns Per-batch counts, the invalid list and own-org existing members.
 */
export async function mintInviteBatch(deps: MintBatchDeps): Promise<MintSummary> {
  const { recipients, ...ctx } = deps;
  const summary: MintSummary = { sent: 0, resent: 0, invalid: [], existing: [] };
  // De-duplicate within the batch.
  const seen = new Set<string>();

  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (!isEmailAddress(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'invalid_email' });
      continue;
    }
    if (seen.has(email)) {
      summary.invalid.push({ email: recipient.email, reason: 'duplicate_in_batch' });
      continue;
    }
    seen.add(email);

    const account = await accountFor(email, ctx.orgId, ctx.role); // NOSONAR typescript:S9382 — sequential by design
    if (account.kind === 'error') {
      summary.invalid.push({ email: recipient.email, reason: 'store_error' });
    } else if (account.kind === 'own_coordinator') {
      summary.existing.push({ email: recipient.email, status: account.status });
    } else if (account.kind === 'other_account') {
      tally(summary, recipient.email, await inviteExistingAccount(ctx, email)); // NOSONAR typescript:S9382 — sequential by design
    } else {
      tally(summary, recipient.email, await inviteNewAddress(ctx, email, recipient.name)); // NOSONAR typescript:S9382 — sequential by design
    }
  }
  return summary;
}
