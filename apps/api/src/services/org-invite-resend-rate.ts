/**
 * Injectable rate-limit check for re-sending an approved org's
 * coordinator-invite link.
 *
 * Belongs to `@aggregator-dpg/api`. Guards the `active` branch of
 * `POST /v1/orgs/create`, where an owner who lost their invite email
 * re-submits the registration form and is mailed a fresh grant. That branch
 * turned a no-op 409 into a credential-minting path, so it needs its own
 * bound rather than relying on the route's inherited submit limiter.
 *
 * Two deliberate differences from `checkSubmitRate`, which this sits
 * alongside rather than replaces:
 *
 * - **Keyed on the stored owner email alone**, not `ip|email`. The submit
 *   limiter's IP component means rotating IPs buys a fresh bucket for the
 *   same owner, so per-owner flooding is unbounded even with Redis healthy.
 * - **Fail-closed.** Each admitted call mints an independent 90-day grant
 *   that can mint coordinator invites, with no revocation and no cap on live
 *   grants. A downed Redis must not silently remove that bound — the same
 *   reasoning as the invite-mint bucket (#700 §7.2) and the approval-verify
 *   throttle (A2).
 *
 * Fail-closed is safe here precisely because the key is narrow: an outage
 * blocks re-sends for one email address, not everyone behind one NAT.
 *
 * Route handlers stay testable without Redis; tests override via
 * `_setOrgInviteResendRateChecker`.
 *
 * @module @aggregator-dpg/api
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

/** Outcome of one resend rate check. */
export interface OrgInviteResendRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (ownerEmail: string) => Promise<OrgInviteResendRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis default). */
export function _setOrgInviteResendRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot from the invite-resend bucket for an owner address.
 *
 * @param ownerEmail - The org's STORED owner email. Never the address the
 *   caller submitted: the org form is anonymous, so keying on submitted input
 *   would let an attacker pick an unused bucket for every request.
 * @returns Whether the resend is allowed + retry-after seconds.
 */
export async function checkOrgInviteResendRate(
  ownerEmail: string,
): Promise<OrgInviteResendRateResult> {
  if (override) return override(ownerEmail);
  const r = await consume({
    namespace: 'org-invite-resend',
    key: ownerEmail.toLowerCase(),
    windowSeconds: config.ORG_INVITE_RESEND_RATE_WINDOW_SECONDS,
    max: config.ORG_INVITE_RESEND_RATE_MAX_PER_WINDOW,
    failClosed: true,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
