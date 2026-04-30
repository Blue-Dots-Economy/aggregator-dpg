/**
 * Applicant-approved email — sent on `approve`. Welcomes the user and
 * points them at the portal sign-in page. Uses OTP login, so no password
 * is included.
 */

import { ctaButton, escapeHtml, renderShell } from './shared.js';

export interface ApplicantApprovedVars {
  contactName: string;
  association: string;
  identifier: string; // email or phone the user registered with
  signInUrl: string;
}

export function renderApplicantApproved(v: ApplicantApprovedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Your Blue Dots aggregator account is approved';
  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  Welcome to Blue Dots, ${escapeHtml(v.contactName)}.
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  Your application for <strong>${escapeHtml(v.association)}</strong> has been approved. You can sign in to the Aggregator Portal now.
</p>
<p style="margin:0 0 22px;font-size:14px;color:#475069;line-height:1.55;">
  Use the email or mobile number you registered (<strong>${escapeHtml(v.identifier)}</strong>) — we'll send a one-time code to verify it.
</p>
<div style="margin:0 0 18px;">
  ${ctaButton('Sign in to Blue Dots', v.signInUrl, 'primary')}
</div>
<p style="margin:0;font-size:12px;color:#7c84a6;line-height:1.55;">
  Trouble signing in? Reply to this email and the Blue Dots team will help.
</p>
`;
  const text = `Welcome to Blue Dots, ${v.contactName}.

Your application for ${v.association} has been approved. You can sign in to the Aggregator Portal now.

Use the email or mobile number you registered (${v.identifier}) — we'll send a one-time code to verify it.

Sign in: ${v.signInUrl}
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
