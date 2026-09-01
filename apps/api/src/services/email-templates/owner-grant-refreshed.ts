/**
 * Owner grant-refreshed email (#701) — sent when an org owner requests a fresh
 * invite-management link because their previous one expired.
 *
 * Belongs to `@aggregator-dpg/api`. Distinct from `org-owner-approved` on
 * purpose: the owner did NOT just get approved (that may have been 90+ days
 * ago), they asked for a new link — so reusing the approval email would read as
 * a duplicate or a phishing attempt. No sign-in CTA (the owner has no account).
 */

import { ctaButton, escapeHtml, getEmailBrand, renderShell } from './shared.js';

/**
 * Template inputs for the owner grant-refreshed email.
 */
export interface OwnerGrantRefreshedVars {
  /** The organisation the refreshed link manages invites for. */
  orgName: string;
  /** The invite-management page URL carrying the fresh grant token. */
  inviteUrl: string;
}

/**
 * Renders the owner grant-refreshed email (subject + HTML + plain-text parts).
 *
 * @param v - Organisation name and the fresh invite-management link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOwnerGrantRefreshed(v: OwnerGrantRefreshedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const subject = `Your new invite link for ${v.orgName}`;

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  Here's your new invite link.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  You asked for a fresh link to invite coordinators for <strong>${escapeHtml(v.orgName)}</strong> on ${escapeHtml(brand.long_name)}. Your previous link had expired — this one replaces it and works for the next 90 days.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Open your invite page', v.inviteUrl, 'primary')}
</div>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  You don't need to sign in — you manage your coordinators entirely from this link. Keep this email so you can find it again.
</p>
<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">
  Didn't request this? You can safely ignore this email — the link only works for your organisation.
</p>
`;

  const text = `Here's your new invite link.

You asked for a fresh link to invite coordinators for ${v.orgName} on ${brand.long_name}. Your previous link had expired — this one replaces it and works for the next 90 days.

Open your invite page: ${v.inviteUrl}

You don't need to sign in — you manage your coordinators entirely from this link. Keep this email so you can find it again.

Didn't request this? You can safely ignore this email — the link only works for your organisation.

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
