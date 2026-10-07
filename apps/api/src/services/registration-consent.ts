/**
 * Server-side stamping of a registration's consent (`@aggregator-dpg/api`).
 * Shared by coordinator and org registration so both store the same
 * server-authoritative `given_at` and the same clamped `valid_till` in the
 * consent ledger (migration 0029, D4-4).
 */

/**
 * Maximum consent validity window. Hard ceiling so a buggy or hostile
 * client cannot persist a consent record that is effectively permanent.
 * Five years lines up with typical regulatory retention envelopes; tune
 * via config if a deployment needs something different.
 */
export const MAX_CONSENT_VALIDITY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** The consent block a registration form submits. */
export interface SubmittedConsent {
  value: true;
  given_at: string;
  valid_till: string;
}

/**
 * Server-stamps `given_at` to the current instant and clamps `valid_till` to
 * at most {@link MAX_CONSENT_VALIDITY_MS} after that instant. The client may
 * ask for a shorter window but never a longer one; an unparseable
 * `valid_till` gets the maximum.
 *
 * @param incoming - Consent block as it arrived from the registration form.
 * @param now - The current instant (injectable for tests).
 * @returns Consent record with server-authoritative timestamps, or `null`
 *   when `valid_till` is not after `now` (a consent born expired is refused).
 */
export function stampConsent<T extends SubmittedConsent>(
  incoming: T,
  now: Date = new Date(),
): T | null {
  const maxValidTill = new Date(now.getTime() + MAX_CONSENT_VALIDITY_MS);
  const requestedValidTill = new Date(incoming.valid_till);
  if (Number.isFinite(requestedValidTill.getTime()) && requestedValidTill <= now) return null;
  const validTill =
    Number.isFinite(requestedValidTill.getTime()) && requestedValidTill < maxValidTill
      ? requestedValidTill
      : maxValidTill;
  return {
    ...incoming,
    given_at: now.toISOString(),
    valid_till: validTill.toISOString(),
  };
}
