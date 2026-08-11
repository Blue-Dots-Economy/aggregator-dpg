/**
 * Registration-form gate predicates.
 *
 * Decides — purely from the per-domain `network.json` config surfaced via
 * `GET /v1/aggregator-config` — whether the anonymous registration form should
 * show the profile-creation **consent step** and the **birth-year** field.
 * Mirrors `@aggregator-dpg/network-config/interface`'s server-side predicates;
 * duplicated here as plain functions because the web app must not bundle the
 * node config package (see `useAggregatorConfig` note). Keep the two in sync.
 *
 * @module @aggregator-dpg/web/lib/registration-gates
 */

import type { AggregatorConfigDomain } from '../hooks/useAggregatorConfig';

/**
 * Go-live gate token meaning "profile-creation consent must be accepted before
 * the profile can go live". Single source of truth for the token on the web.
 */
export const CONSENT_REQUIRED_GATE = 'consent_required';

/**
 * Whether the registration form should show the profile-creation consent step
 * for a domain. True iff the domain's `go_live_required` includes
 * {@link CONSENT_REQUIRED_GATE}. Absent/empty ⇒ false (no consent step).
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when the consent step must be shown.
 */
export function domainRequiresConsent(domain: AggregatorConfigDomain | undefined): boolean {
  return (domain?.go_live_required ?? []).includes(CONSENT_REQUIRED_GATE);
}

/**
 * Whether the registration form should collect a birth year for a domain.
 * True iff the domain requires guardian consent (U18 gating). Absent ⇒ false.
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when a birth year must be collected.
 */
export function domainRequiresBirthYear(domain: AggregatorConfigDomain | undefined): boolean {
  return domain?.guardian_consent_required === true;
}
