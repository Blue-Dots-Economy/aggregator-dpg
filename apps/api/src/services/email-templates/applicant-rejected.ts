/**
 * Applicant-rejected email. Polite decline; optional reason rendered
 * verbatim if supplied by the admin.
 */

import { escapeHtml, getEmailBrand, renderShell } from './shared.js';

export interface ApplicantRejectedVars {
  /**
   * Personal name of the applicant contact. Optional because the org flow has
   * no owner-name column — the name given at org registration is only used to
   * build the Keycloak user — so that path greets without one rather than
   * addressing a person by their organisation's name.
   */
  contactName?: string | undefined;
  association: string;
  reason?: string | undefined;
  /**
   * What was rejected — drives the subject and the opening line. Use
   * `organisation` for the org flow, `aggregator` (default) for coordinators.
   */
  entityLabel?: string | undefined;
}

export function renderApplicantRejected(v: ApplicantRejectedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const label = v.entityLabel ?? 'aggregator';
  const subject = `Update on your ${brand.short_name} ${label} application`;
  const greeting = v.contactName ? `Hi ${escapeHtml(v.contactName)},` : 'Hi there,';
  const reasonBlock = v.reason
    ? `<div style="margin:18px 0 0;padding:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;font-size:13.5px;color:#7f1d1d;line-height:1.55;">
         <strong>Reason:</strong> ${escapeHtml(v.reason)}
       </div>`
    : '';

  const body = `
<h1 style="font-size:22px;font-weight:700;letter-spacing:-0.01em;margin:0 0 12px;color:#0b1020;">
  ${greeting}
</h1>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  Thanks for applying to onboard <strong>${escapeHtml(v.association)}</strong> as a ${escapeHtml(brand.short_name)} ${escapeHtml(label)}.
</p>
<p style="margin:0 0 14px;font-size:14px;color:#475069;line-height:1.55;">
  After review, we are unable to approve your application at this time.
</p>
${reasonBlock}
<p style="margin:18px 0 0;font-size:13.5px;color:#475069;line-height:1.55;">
  If you believe this was a mistake, reply to this email with additional context and our team will take a second look.
</p>
`;
  const text = `${v.contactName ? `Hi ${v.contactName},` : 'Hi there,'}

Thanks for applying to onboard ${v.association} as a ${brand.short_name} ${label}.

After review, we are unable to approve your application at this time.${
    v.reason
      ? `

Reason: ${v.reason}`
      : ''
  }

If you believe this was a mistake, reply to this email with additional context and our team will take a second look.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
