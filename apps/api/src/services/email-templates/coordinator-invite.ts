/**
 * Coordinator-invite email — sent when an org owner mints an invite (#701).
 *
 * Belongs to `@aggregator-dpg/api`. Tells the recipient who invited them, which
 * organisation they're joining, the one-time registration link, and when it
 * expires. The link carries the email-bound invite token; the recipient
 * registers with the address this email was sent to.
 */

import { ctaButton, escapeHtml, getEmailBrand, renderShell } from './shared.js';

/**
 * Template inputs for the coordinator-invite email.
 */
export interface CoordinatorInviteVars {
  /** Organisation the recipient is being invited to join. */
  orgName: string;
  /** Registration link carrying the invite token. */
  inviteUrl: string;
  /** Human phrase for the invite lifetime, e.g. "14 days". */
  expiresInText: string;
  /** Optional recipient name for a personal greeting (not stored/enforced). */
  recipientName?: string;
}

/**
 * Renders the coordinator-invite email (subject + HTML + plain-text parts).
 *
 * @param v - Org name, invite link, expiry phrase, optional recipient name.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderCoordinatorInvite(v: CoordinatorInviteVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const greeting = v.recipientName ? `Hi ${escapeHtml(v.recipientName)},` : 'Hello,';
  const subject = `You're invited to join ${v.orgName} on ${brand.short_name}`;

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  Join ${escapeHtml(v.orgName)} on ${escapeHtml(brand.short_name)}.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  ${greeting} <strong>${escapeHtml(v.orgName)}</strong> has invited you to register as a coordinator on ${escapeHtml(brand.long_name)}.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Register as a coordinator', v.inviteUrl, 'primary')}
</div>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  This invite is personal to this email address and expires in ${escapeHtml(v.expiresInText)}. Register with the email address this message was sent to.
</p>
<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">
  Didn't expect this? You can ignore this email — no account is created until you register.
</p>
`;

  const text = `Join ${v.orgName} on ${brand.short_name}.

${v.recipientName ? `Hi ${v.recipientName},` : 'Hello,'} ${v.orgName} has invited you to register as a coordinator on ${brand.long_name}.

Register: ${v.inviteUrl}

This invite is personal to this email address and expires in ${v.expiresInText}. Register with the email address this message was sent to.

Didn't expect this? You can ignore this email — no account is created until you register.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
