/**
 * Admin review email — sent to ADMIN_EMAILS when a new aggregator
 * registration arrives. Two CTA buttons (Approve / Reject) link to the
 * confirmation page rendered by the API.
 */

import { ctaButton, escapeHtml, renderShell } from './shared.js';

export interface AdminReviewVars {
  registrationId: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string;
  association: string;
  aggregatorType: 'seeker' | 'provider';
  state?: string | undefined;
  about?: string | undefined;
  /** Pre-built deep links — already include the signed token + intent. */
  approveUrl: string;
  rejectUrl: string;
  submittedAt: Date;
}

export function renderAdminReview(v: AdminReviewVars): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Action required: aggregator registration from ${v.association}`;
  const submitted = v.submittedAt.toUTCString();
  const stateRow = v.state
    ? `<tr><td style="padding:6px 0;color:#475069;width:140px;">State</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.state)}</td></tr>`
    : '';
  const aboutBlock = v.about
    ? `<div style="margin-top:16px;padding:14px;background:#f7f8fb;border-radius:10px;font-size:13px;color:#0b1020;line-height:1.5;">${escapeHtml(v.about)}</div>`
    : '';

  const body = `
<h1 style="font-size:20px;font-weight:700;letter-spacing:-0.01em;margin:0 0 8px;color:#0b1020;">New aggregator registration</h1>
<p style="margin:0 0 18px;font-size:14px;color:#475069;line-height:1.5;">
  ${escapeHtml(v.association)} has submitted an aggregator registration. Review and approve or reject below.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13.5px;">
  <tr><td style="padding:6px 0;color:#475069;width:140px;">Association</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.association)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Type</td><td style="padding:6px 0;color:#0b1020;text-transform:capitalize;">${escapeHtml(v.aggregatorType)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Contact</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantName)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Email</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantEmail)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Phone</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantPhone)}</td></tr>
  ${stateRow}
  <tr><td style="padding:6px 0;color:#475069;">Submitted</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(submitted)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Reference</td><td style="padding:6px 0;color:#0b1020;font-family:monospace;font-size:12px;">${escapeHtml(v.registrationId)}</td></tr>
</table>
${aboutBlock}

<div style="margin-top:28px;display:flex;gap:10px;">
  ${ctaButton('Review and approve', v.approveUrl, 'primary')}
  &nbsp;&nbsp;
  ${ctaButton('Review and reject', v.rejectUrl, 'danger')}
</div>

<p style="margin:22px 0 0;font-size:12px;color:#7c84a6;line-height:1.5;">
  Each link opens a confirmation page. Decisions are final once confirmed.
  The link is single-use and expires in 7 days.
</p>
`;

  const text = `New aggregator registration

Association: ${v.association}
Type:        ${v.aggregatorType}
Contact:     ${v.applicantName}
Email:       ${v.applicantEmail}
Phone:       ${v.applicantPhone}
${v.state ? `State:       ${v.state}\n` : ''}Submitted:   ${submitted}
Reference:   ${v.registrationId}
${v.about ? `\nAbout:\n${v.about}\n` : ''}
Approve: ${v.approveUrl}
Reject:  ${v.rejectUrl}

Each link opens a confirmation page. Single-use, expires in 7 days.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
