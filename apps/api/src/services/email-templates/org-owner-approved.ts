/**
 * Org-owner approved email — sent when the network admin approves an
 * organisation in the org → coordinator hierarchy (#699).
 *
 * Belongs to `@aggregator-dpg/api`. This is the notification an approved org
 * owner receives telling them their organisation is live; today the approval
 * path sends nothing, so owners hear nothing after approval — this template
 * closes that gap and is the carrier for the coordinator-invite link once it
 * exists.
 *
 * Deliberately carries **no sign-in CTA**: on approval the owner's Keycloak
 * user is left disabled (org-owner console login is deferred), so a sign-in
 * link would be a dead end / fail the OTP step. Email is the owner's only
 * interaction surface until the org console ships. When the coordinator-invite
 * grant link lands (#701) it is passed as `inviteUrl` and rendered as the sole
 * CTA; until then the "you're live" notification ships on its own.
 */

import { ctaButton, escapeHtml, getEmailBrand, renderShell } from './shared.js';

/**
 * Template inputs for the org-owner approved email.
 */
export interface OrgOwnerApprovedVars {
  /** The organisation's display name, as registered. */
  orgName: string;
  /** The owner email the organisation was registered with. */
  ownerEmail: string;
  /**
   * Coordinator-invite grant link, when it exists (#701). Omit until the
   * invite subsystem ships — the approval notification has standalone value.
   */
  inviteUrl?: string;
}

/**
 * Renders the org-owner approved email (subject + HTML + plain-text parts).
 *
 * @param v - Organisation name, owner email, and the optional invite link.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgOwnerApproved(v: OrgOwnerApprovedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const subject = `${brand.short_name}: ${v.orgName} is approved`;

  // Coordinators join ONLY when the owner invites them (#700 removed self-serve
  // registration) — so the CTA is the owner's next action, not a passive notice.
  // The block only renders when the grant link exists; until then it's a heads-up.
  const inviteHtml = v.inviteUrl
    ? `<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  Coordinators can only join <strong>${escapeHtml(v.orgName)}</strong> when you invite them. Invite them by email below — each person gets their own one-time invite.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Invite your coordinators', v.inviteUrl, 'primary')}
</div>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  You don't need an account and you can't sign in — you manage your coordinators entirely from the button above. Keep this email so you can find it again; the link works for 90 days. If it ever stops working, just open it and send again — we'll email you a fresh link automatically.
</p>`
    : `<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  Coordinators join only when you invite them. You'll be able to invite them by email shortly — we'll send you the invite link in a follow-up message.
</p>`;

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  ${escapeHtml(v.orgName)} is approved.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  Your organisation is now live on ${escapeHtml(brand.long_name)} (registered with <strong>${escapeHtml(v.ownerEmail)}</strong>).
</p>
${inviteHtml}
`;

  const text = `${v.orgName} is approved.

Your organisation is now live on ${brand.long_name} (registered with ${v.ownerEmail}).

${
  v.inviteUrl
    ? `Coordinators can only join ${v.orgName} when you invite them. Invite them by email — each person gets their own one-time invite:\n${v.inviteUrl}\n\nYou don't need an account and you can't sign in — you manage your coordinators entirely from that link. Keep this email; the link works for 90 days. If it ever stops working, just open it and send again and we'll email you a fresh link automatically.`
    : `Coordinators join only when you invite them. You'll be able to invite them by email shortly — we'll send you the invite link in a follow-up message.`
}
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
