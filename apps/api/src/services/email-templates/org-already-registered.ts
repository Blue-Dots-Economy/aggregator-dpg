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
 *
 * Copy lives under the `org_already_registered.*` keys.
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
 * A duration ("expires in 90 days") is meaningless by the time someone reads
 * a mail they kept, so the wire value is a fixed date.
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
  const types = caseTokenTypes('org_already_registered');
  const values = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    orgName: v.orgName,
    expiresOn: formatExpiryDate(v.expiresAt),
  };
  const copy = (key: string): string =>
    substitute(getMessage(`org_already_registered.${key}`), values, types);

  const subject = toPlainText(copy('subject'));
  const headingHtml = copy('heading');
  const introHtml = copy('intro');
  const reasonHtml = copy('reason');
  const ctaLabel = toPlainText(copy('cta'));
  const noteHtml = copy('note');
  const footnoteHtml = copy('footnote');

  const body = [
    heading(headingHtml),
    para(introHtml),
    para(reasonHtml),
    ctaRow(ctaButton(ctaLabel, v.inviteUrl, 'primary')),
    paraLast(noteHtml),
    note(footnoteHtml),
  ].join('\n');

  const text = `${toPlainText(headingHtml)}

${toPlainText(introHtml)}

${toPlainText(reasonHtml)}

${ctaLabel}: ${v.inviteUrl}

${toPlainText(noteHtml)}

${toPlainText(footnoteHtml)}

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
