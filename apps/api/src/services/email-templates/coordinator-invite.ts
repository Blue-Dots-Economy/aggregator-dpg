/**
 * Coordinator-invite email (#700/#701) — sent to each recipient an org owner
 * invites, carrying the registration link with their personal invite token.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under the
 * `coordinator_invite.*` keys. The greeting is two keys rather than a
 * conditional string, and is substituted into `intro` as a pre-escaped
 * `html` token so the sentence reads naturally either way.
 */

import {
  ctaButton,
  ctaRow,
  getEmailBrand,
  heading,
  note,
  para,
  paraLast,
  renderShell,
} from './shared.js';
import { caseTokenTypes } from './email-cases.js';
import { getMessage } from './messages.js';
import { substitute, toPlainText } from './substitute.js';

/**
 * Template inputs for the coordinator-invite email.
 */
export interface CoordinatorInviteVars {
  /** Organisation the recipient is being invited to join. */
  orgName: string;
  /** Contact address of the inviting org (its owner) — sender identity + support. */
  inviterEmail: string;
  /** Registration link carrying the invite token. */
  inviteUrl: string;
  /** Absolute expiry, pre-formatted (e.g. "15 Sep 2026"). */
  expiresOn: string;
  /** Optional recipient name for a personal greeting (not stored/enforced). */
  recipientName?: string;
}

/**
 * Renders the coordinator-invite email (subject + HTML + plain-text parts).
 *
 * @param v - Org name, inviter contact, invite link, absolute expiry, optional name.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderCoordinatorInvite(v: CoordinatorInviteVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const types = caseTokenTypes('coordinator_invite');
  const base = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    orgName: v.orgName,
    inviterEmail: v.inviterEmail,
    recipientName: v.recipientName,
    expiresOn: v.expiresOn,
  };
  const copy = (key: string, extra: Record<string, string> = {}): string =>
    substitute(getMessage(`coordinator_invite.${key}`), { ...base, ...extra }, types);

  const greetingHtml = copy(v.recipientName ? 'greeting' : 'greeting_anonymous');
  const subject = toPlainText(copy('subject'));
  const headingHtml = copy('heading');
  const introHtml = copy('intro', { greeting: greetingHtml });
  const roleHtml = copy('role');
  const ctaLabel = toPlainText(copy('cta'));
  const expiryHtml = copy('expiry');
  const nextHtml = copy('next');
  const footnoteHtml = copy('footnote');

  const body = [
    heading(headingHtml),
    para(introHtml),
    para(roleHtml),
    ctaRow(ctaButton(ctaLabel, v.inviteUrl, 'primary')),
    para(expiryHtml),
    paraLast(nextHtml),
    note(footnoteHtml),
  ].join('\n');

  const text = `${toPlainText(headingHtml)}

${toPlainText(introHtml)} ${toPlainText(roleHtml)}

${ctaLabel}: ${v.inviteUrl}

${toPlainText(expiryHtml)}

${toPlainText(nextHtml)}

${toPlainText(footnoteHtml)}

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
