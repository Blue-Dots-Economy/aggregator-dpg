/**
 * Applicant-rejected email. Polite decline; optional reason rendered verbatim
 * if supplied by the admin.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under the
 * `applicant_rejected.*` keys. The greeting has two keys rather than one
 * conditional string: the org flow has no owner-name column, so that path
 * greets without a name instead of addressing a person by their
 * organisation's name.
 */

import { callout, getEmailBrand, heading, para, renderShell } from './shared.js';
import { caseTokenTypes } from './email-cases.js';
import { getMessage } from './messages.js';
import { substitute, toPlainText } from './substitute.js';

/**
 * Template inputs for the applicant-rejected email.
 */
export interface ApplicantRejectedVars {
  /**
   * Personal name of the applicant contact. Optional because the org flow has
   * no owner-name column — the name given at org registration is only used to
   * build the Keycloak user.
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

/**
 * Renders the applicant-rejected email (subject + HTML + plain-text parts).
 *
 * @param v - Association, optional contact name, optional reason and label.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderApplicantRejected(v: ApplicantRejectedVars): {
  subject: string;
  html: string;
  text: string;
} {
  const brand = getEmailBrand();
  const types = caseTokenTypes('applicant_rejected');
  const values = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    contactName: v.contactName,
    association: v.association,
    entityLabel: v.entityLabel ?? 'aggregator',
    reason: v.reason,
  };
  const copy = (key: string): string =>
    substitute(getMessage(`applicant_rejected.${key}`), values, types);

  const subject = toPlainText(copy('subject'));
  const greetingHtml = copy(v.contactName ? 'greeting' : 'greeting_anonymous');
  const introHtml = copy('intro');
  const outcomeHtml = copy('outcome');
  const appealHtml = copy('appeal');
  const reasonHtml = v.reason ? copy('reason') : '';

  const body = [
    heading(greetingHtml),
    para(introHtml),
    para(outcomeHtml),
    ...(reasonHtml ? [callout(reasonHtml)] : []),
    `<p style="margin:18px 0 0;font-size:13.5px;color:#475069;line-height:1.55;">\n  ${appealHtml}\n</p>`,
  ].join('\n');

  const reasonText = reasonHtml ? `\n\n${toPlainText(reasonHtml)}` : '';
  const text = `${toPlainText(greetingHtml)}

${toPlainText(introHtml)}

${toPlainText(outcomeHtml)}${reasonText}

${toPlainText(appealHtml)}
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
