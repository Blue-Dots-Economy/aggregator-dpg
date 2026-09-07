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
 * Copy lives under `org_already_registered.*`.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

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
 * Renders the organisation-already-registered email.
 *
 * @param v - Organisation name, invite-management link, and the grant expiry.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderOrgAlreadyRegistered(v: OrgAlreadyRegisteredVars): RenderedEmail {
  return renderCase('org_already_registered', {
    orgName: v.orgName,
    inviteUrl: v.inviteUrl,
    expiresOn: formatExpiryDate(v.expiresAt),
  });
}
