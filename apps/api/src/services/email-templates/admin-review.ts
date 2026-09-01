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
  /**
   * What was registered — drives the subject, heading, and Type row. Use
   * `organisation` for the org flow, `aggregator` (default) for coordinators.
   */
  entityLabel?: string;
  state?: string | undefined;
  about?: string | undefined;
  /**
   * The email the coordinator was INVITED at (#701). When set and different
   * from `applicantEmail`, the review highlights that they're registering with a
   * different address than invited — so the approver can sanity-check it.
   */
  invitedEmail?: string | undefined;
  /** Pre-built review deep link — includes the signed token. Approve/reject is
   * chosen on the page it opens (one link, both actions). */
  reviewUrl: string;
  submittedAt: Date;
  /**
   * Human-readable link lifetime (e.g. "7 days"), derived from the
   * configured approval-token TTL via `formatApprovalTtl`. Must match the
   * wording on the confirmation page.
   */
  expiresInText: string;
}

export function renderAdminReview(v: AdminReviewVars): {
  subject: string;
  html: string;
  text: string;
} {
  const label = v.entityLabel ?? 'aggregator';
  const subject = `Action required: ${label} registration from ${v.association}`;
  // Render the submission time in IST (the server clock is UTC) so the admin
  // reads it in the network's local timezone, matching the approval pages.
  const submitted = `${v.submittedAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} IST`;
  const stateRow = v.state
    ? `<tr><td style="padding:6px 0;color:#475069;width:140px;">State</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.state)}</td></tr>`
    : '';
  const aboutBlock = v.about
    ? `<div style="margin-top:16px;padding:14px;background:#f7f8fb;border-radius:10px;font-size:13px;color:#0b1020;line-height:1.5;">${escapeHtml(v.about)}</div>`
    : '';
  // Highlight when the coordinator registered with a different email than the
  // one they were invited at (#701) — the approver should sanity-check it.
  const emailMismatch = Boolean(v.invitedEmail && v.invitedEmail !== v.applicantEmail);
  const invitedRow = emailMismatch
    ? `<tr><td style="padding:6px 0;color:#b45309;width:140px;">Invited email</td><td style="padding:6px 0;color:#b45309;">${escapeHtml(v.invitedEmail as string)} <span style="color:#7c84a6;">— they're registering with a different email (above)</span></td></tr>`
    : '';

  const body = `
<h1 style="font-size:20px;font-weight:700;letter-spacing:-0.01em;margin:0 0 8px;color:#0b1020;text-transform:capitalize;">New ${escapeHtml(label)} registration</h1>
<p style="margin:0 0 18px;font-size:14px;color:#475069;line-height:1.5;">
  ${escapeHtml(v.association)} has submitted an ${escapeHtml(label)} registration. Review and approve or reject below.
</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13.5px;">
  <tr><td style="padding:6px 0;color:#475069;width:140px;">Association</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.association)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Type</td><td style="padding:6px 0;color:#0b1020;text-transform:capitalize;">${escapeHtml(label)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Contact</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantName)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Email</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantEmail)}</td></tr>
  ${invitedRow}
  <tr><td style="padding:6px 0;color:#475069;">Phone</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(v.applicantPhone)}</td></tr>
  ${stateRow}
  <tr><td style="padding:6px 0;color:#475069;">Submitted</td><td style="padding:6px 0;color:#0b1020;">${escapeHtml(submitted)}</td></tr>
  <tr><td style="padding:6px 0;color:#475069;">Reference</td><td style="padding:6px 0;color:#0b1020;font-family:monospace;font-size:12px;">${escapeHtml(v.registrationId)}</td></tr>
</table>
${aboutBlock}

<div style="margin-top:28px;">
  ${ctaButton('Review registration', v.reviewUrl, 'primary')}
</div>

<p style="margin:22px 0 0;font-size:12px;color:#7c84a6;line-height:1.5;">
  The link opens a review page where you can approve or reject. The decision is
  final once submitted. The link is single-use and expires in ${escapeHtml(v.expiresInText)}.
</p>
`;

  const text = `New ${label} registration

Association: ${v.association}
Type:        ${label}
Contact:     ${v.applicantName}
Email:       ${v.applicantEmail}
${emailMismatch ? `Invited email: ${v.invitedEmail} (registering with a different email)\n` : ''}Phone:       ${v.applicantPhone}
${v.state ? `State:       ${v.state}\n` : ''}Submitted:   ${submitted}
Reference:   ${v.registrationId}
${v.about ? `\nAbout:\n${v.about}\n` : ''}
Review (approve or reject): ${v.reviewUrl}

The link opens a review page where you approve or reject. Single-use, expires in ${v.expiresInText}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
