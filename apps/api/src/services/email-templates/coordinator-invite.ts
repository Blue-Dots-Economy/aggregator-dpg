/**
 * Coordinator-invite email — sent when an org owner mints an invite (#701).
 *
 * Belongs to `@aggregator-dpg/api`. This is the only email sent cold, in bulk,
 * to people who may not know the platform — so it carries full context: who
 * invited them (the org + owner contact), what a coordinator is, the one-time
 * link, when it expires (absolute date), and what happens after they register.
 */

import { ctaButton, escapeHtml, getEmailBrand, renderShell } from './shared.js';

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
  const greeting = v.recipientName ? `Hi ${escapeHtml(v.recipientName)},` : 'Hello,';
  const subject = `${v.orgName} invited you to join ${brand.short_name} as a coordinator`;

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  You're invited to join ${escapeHtml(v.orgName)}.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  ${greeting} <strong>${escapeHtml(v.orgName)}</strong> (${escapeHtml(v.inviterEmail)}) has invited you to register as a coordinator on ${escapeHtml(brand.long_name)}.
</p>
<p style="margin:0 0 18px;font-size:14px;color:#475069;line-height:1.55;">
  As a coordinator you'll help ${escapeHtml(v.orgName)} register and support participants on ${escapeHtml(brand.short_name)}.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Register as a coordinator', v.inviteUrl, 'primary')}
</div>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  This invite is personal to this email address and expires on <strong>${escapeHtml(v.expiresOn)}</strong>. Register with the email address this message was sent to.
</p>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  After you register, ${escapeHtml(v.orgName)} reviews your request and you'll get a confirmation email. Questions? Contact your organisation at ${escapeHtml(v.inviterEmail)}.
</p>
<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">
  Didn't expect this? You can ignore this email — no account is created until you register.
</p>
`;

  const text = `You're invited to join ${v.orgName}.

${v.recipientName ? `Hi ${v.recipientName},` : 'Hello,'} ${v.orgName} (${v.inviterEmail}) has invited you to register as a coordinator on ${brand.long_name}. As a coordinator you'll help ${v.orgName} register and support participants on ${brand.short_name}.

Register as a coordinator: ${v.inviteUrl}

This invite is personal to this email address and expires on ${v.expiresOn}. Register with the email address this message was sent to.

After you register, ${v.orgName} reviews your request and you'll get a confirmation email. Questions? Contact your organisation at ${v.inviterEmail}.

Didn't expect this? You can ignore this email — no account is created until you register.

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
