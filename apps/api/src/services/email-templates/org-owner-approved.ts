/**
 * Org-owner approved email (#699) — tells the org owner their organisation is
 * live. No sign-in CTA: the owner's Keycloak user stays disabled by design
 * (org-owner console login is deferred), so the invite link is their only
 * action.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under the
 * `org_owner_approved.*` keys. The tail has two variants rather than one
 * conditional string: with the grant link, and before the invite subsystem is
 * reachable for this deployment.
 */

import {
  ctaButton,
  ctaRow,
  getEmailBrand,
  heading,
  para,
  paraLast,
  renderShell,
} from './shared.js';
import { caseTokenTypes } from './email-cases.js';
import { getMessage } from './messages.js';
import { substitute, toPlainText } from './substitute.js';

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
  const types = caseTokenTypes('org_owner_approved');
  const values = {
    brandShort: brand.short_name,
    brandLong: brand.long_name,
    orgName: v.orgName,
    ownerEmail: v.ownerEmail,
  };
  const copy = (key: string): string =>
    substitute(getMessage(`org_owner_approved.${key}`), values, types);

  const subject = toPlainText(copy('subject'));
  const headingHtml = copy('heading');
  const introHtml = copy('intro');

  const tailHtml: string[] = [];
  const tailText: string[] = [];
  if (v.inviteUrl) {
    const leadHtml = copy('invite_lead');
    const ctaLabel = toPlainText(copy('cta'));
    const noteHtml = copy('invite_note');
    tailHtml.push(
      para(leadHtml),
      ctaRow(ctaButton(ctaLabel, v.inviteUrl, 'primary')),
      paraLast(noteHtml),
    );
    tailText.push(`${toPlainText(leadHtml)}\n${ctaLabel}: ${v.inviteUrl}`, toPlainText(noteHtml));
  } else {
    const pendingHtml = copy('invite_pending');
    tailHtml.push(paraLast(pendingHtml));
    tailText.push(toPlainText(pendingHtml));
  }

  const body = [heading(headingHtml), para(introHtml), ...tailHtml].join('\n');

  const text = `${toPlainText(headingHtml)}

${toPlainText(introHtml)}

${tailText.join('\n\n')}
`;

  return { subject, html: renderShell({ preheader: subject, bodyHtml: body }), text };
}
