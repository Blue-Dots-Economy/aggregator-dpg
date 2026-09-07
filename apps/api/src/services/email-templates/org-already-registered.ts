/**
 * Organisation-already-registered email — sent when someone submits the org
 * registration form for an organisation that is already approved and live.
 *
 * Belongs to `@aggregator-dpg/api`. Distinct from `owner-grant-refreshed` on
 * purpose: that one answers "my link expired", this one answers "I tried to
 * register again". The recipient just filled in the registration form, so the
 * mail has to acknowledge that attempt — otherwise it reads as unprompted, or
 * as phishing. No sign-in CTA (the owner has no account); the coordinator
 * invite link is the whole point of the message.
 *
 * Always addressed to the owner email ON FILE, never the address that was
 * submitted — the org form is anonymous, so mailing the submitted address
 * would hand a stranger the org's invite credential.
 */

import { ctaButton, escapeHtml, getEmailBrand, renderShell } from './shared.js';

/**
 * Template inputs for the organisation-already-registered email.
 */
export interface OrgAlreadyRegisteredVars {
  /** Display name of the organisation that is already registered. */
  orgName: string;
  /** The invite-management page URL carrying the grant token. */
  inviteUrl: string;
  /** Absolute expiry of the grant token; rendered as a date, not a duration. */
  expiresAt: Date;
}

/**
 * Formats an absolute expiry date for the email (e.g. "15 Sep 2026").
 *
 * A duration ("expires in 90 days") is meaningless by the time someone reads a
 * mail they kept, so the wire value is a fixed date.
 */
function formatExpiryDate(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/**
 * Renders the organisation-already-registered email (subject + HTML + text).
 *
 * @param v - Organisation name, invite-management link, and the grant expiry.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgAlreadyRegistered(v: OrgAlreadyRegisteredVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const subject = `${v.orgName} is already registered`;
  const expiresOn = formatExpiryDate(v.expiresAt);

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  Your organisation is already registered.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  Someone just tried to register <strong>${escapeHtml(v.orgName)}</strong> on ${escapeHtml(brand.long_name)}. It is already approved and live, so there is nothing more to do — you do not need to register again.
</p>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  If that was you because you were looking for your coordinator invitation link, here it is.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Invite coordinators', v.inviteUrl, 'primary')}
</div>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  You do not need to sign in — you invite and manage your coordinators entirely from this link. It works until <strong>${escapeHtml(expiresOn)}</strong>. Keep this email so you can find it again.
</p>
<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">
  Didn't try to register? You can safely ignore this email — nothing changed, and the link only works for your organisation.
</p>
`;

  const text = `Your organisation is already registered.

Someone just tried to register ${v.orgName} on ${brand.long_name}. It is already approved and live, so there is nothing more to do — you do not need to register again.

If that was you because you were looking for your coordinator invitation link, here it is.

Invite coordinators: ${v.inviteUrl}

You do not need to sign in — you invite and manage your coordinators entirely from this link. It works until ${expiresOn}. Keep this email so you can find it again.

Didn't try to register? You can safely ignore this email — nothing changed, and the link only works for your organisation.

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
