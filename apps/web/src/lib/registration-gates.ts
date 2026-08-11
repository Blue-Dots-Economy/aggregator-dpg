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

/**
 * Whether the registration form should show the consent step for a domain.
 *
 * True when the domain gates go-live on consent, OR when it collects a birth
 * year (guardian/U18 domain). Signalstack **force-adds `consent_required` for
 * any guardian-gated domain** (`resolveGoLiveGates` — the U18 age control can
 * never be config-disabled), and its config schema rejects a guardian domain
 * that drops the token. So a birth-year domain always needs the consent step,
 * even if the surfaced `go_live_required` omitted it (config drift / older
 * payload). Mirror that server invariant here rather than trusting
 * `go_live_required` alone — otherwise a guardian domain missing the token
 * would collect DOB but skip consent, and its profiles would never go live.
 *
 * @param domain - The resolved domain config, or undefined when not yet loaded.
 * @returns True when the consent step must be shown.
 */
export function registrationShowsConsent(domain: AggregatorConfigDomain | undefined): boolean {
  return domainRequiresConsent(domain) || domainRequiresBirthYear(domain);
}
