/**
 * Injectable per-org rate-limit check for the invite-mint endpoint (#700 §7.2).
 *
 * Belongs to `@aggregator-dpg/api`. Bounds how many invites one org can mint
 * per window — the mandatory mitigation that stops a leaked owner grant from
 * becoming a platform-branded spam amplifier. Wraps the Redis fixed-window
 * limiter so route handlers stay testable without Redis; tests override via
 * `_setInviteMintRateChecker`.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface InviteMintRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (orgId: string, count: number) => Promise<InviteMintRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis-backed default). */
export function _setInviteMintRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes `count` slots for one org from the invite-mint bucket. A bulk mint
 * of N addresses consumes N slots so the window bounds total invites, not
 * request count.
 *
 * @param orgId - The minting org (`parent_org_id`).
 * @param count - Number of invites this request would mint.
 * @returns Whether the mint is allowed + retry-after seconds.
 */
export async function checkInviteMintRate(
  orgId: string,
  count: number,
): Promise<InviteMintRateResult> {
  if (override) return override(orgId, count);
  const r = await consume({
    namespace: 'invite-mint',
    key: orgId,
    windowSeconds: config.INVITE_MINT_RATE_WINDOW_SECONDS,
    max: config.INVITE_MINT_RATE_MAX_PER_WINDOW,
    cost: count,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
