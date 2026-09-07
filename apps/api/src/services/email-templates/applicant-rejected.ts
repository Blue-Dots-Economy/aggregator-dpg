/**
 * Applicant-rejected email. Polite decline; optional reason rendered verbatim
 * if supplied by the admin.
 *
 * Belongs to `@aggregator-dpg/api`. Copy lives under `applicant_rejected.*`.
 * The greeting is two copy keys chosen by a `oneOf` on the layout rather than
 * a conditional here: the org flow has no owner-name column, so that path
 * greets without a name instead of addressing a person by their
 * organisation's name.
 */

import { renderCase, type RenderedEmail } from './render-case.js';

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
 * Renders the applicant-rejected email.
 *
 * @param v - Association, optional contact name, optional reason and label.
 * @returns The `subject`, `html`, and `text` parts ready for the mailer.
 */
export function renderApplicantRejected(v: ApplicantRejectedVars): RenderedEmail {
  return renderCase('applicant_rejected', {
    contactName: v.contactName,
    association: v.association,
    entityLabel: v.entityLabel ?? 'aggregator',
    reason: v.reason,
  });
}
