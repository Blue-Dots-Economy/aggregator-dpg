/**
 * Owner grant-refreshed email (#701) — sent when an org owner requests a fresh
 * invite-management link because their previous one expired.
 *
 * Belongs to `@aggregator-dpg/api`. Distinct from `org-owner-approved` on
 * purpose: the owner did NOT just get approved (that may have been 90+ days
 * ago), they asked for a new link — so reusing the approval email would read
 * as a duplicate or a phishing attempt. No sign-in CTA (the owner has no
 * account). Copy lives under the `owner_grant_refreshed.*` keys.
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
  const types = caseTokenTypes('owner_grant_refreshed');
  const values = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    orgName: v.orgName,
  };
  const copy = (key: string): string =>
    substitute(getMessage(`owner_grant_refreshed.${key}`), values, types);

  const subject = toPlainText(copy('subject'));
  const headingHtml = copy('heading');
  const introHtml = copy('intro');
  const ctaLabel = toPlainText(copy('cta'));
  const noteHtml = copy('note');
  const footnoteHtml = copy('footnote');

  const body = [
    heading(headingHtml),
    para(introHtml),
    ctaRow(ctaButton(ctaLabel, v.inviteUrl, 'primary')),
    paraLast(noteHtml),
    note(footnoteHtml),
  ].join('\n');

  const text = `${toPlainText(headingHtml)}

${toPlainText(introHtml)}

${ctaLabel}: ${v.inviteUrl}

${toPlainText(noteHtml)}

${toPlainText(footnoteHtml)}

Sent by ${brand.long_name}.
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
