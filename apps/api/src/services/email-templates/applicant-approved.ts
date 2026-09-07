/**
 * Applicant-approved email — sent on `approve`. Welcomes the user and points
 * them at the portal sign-in page. Uses OTP login, so no password is included.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives in the properties layers (see
 * `messages.ts`) under the `applicant_approved.*` keys; this module owns only
 * the block structure and the plain-text derivation.
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
 * Template inputs for the applicant-approved email.
 */
export interface ApplicantApprovedVars {
  contactName: string;
  association: string;
  /** Email or phone the user registered with. */
  identifier: string;
  signInUrl: string;
}

/**
 * Renders the applicant-approved email (subject + HTML + plain-text parts).
 *
 * @param v - Contact name, association, registered identifier, sign-in URL.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderApplicantApproved(v: ApplicantApprovedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const types = caseTokenTypes('applicant_approved');
  const values = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    contactName: v.contactName,
    association: v.association,
    identifier: v.identifier,
  };
  const copy = (key: string): string =>
    substitute(getMessage(`applicant_approved.${key}`), values, types);

  const subject = toPlainText(copy('subject'));
  const headingHtml = copy('heading');
  const introHtml = copy('intro');
  const identifierHtml = copy('identifier');
  const ctaLabel = toPlainText(copy('cta'));
  const footnoteHtml = copy('footnote');

  const body = [
    heading(headingHtml),
    para(introHtml),
    paraLast(identifierHtml),
    ctaRow(ctaButton(ctaLabel, v.signInUrl, 'primary')),
    note(footnoteHtml),
  ].join('\n');

  const text = `${toPlainText(headingHtml)}

${toPlainText(introHtml)}

${toPlainText(identifierHtml)}

${ctaLabel}: ${v.signInUrl}

${toPlainText(footnoteHtml)}

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
