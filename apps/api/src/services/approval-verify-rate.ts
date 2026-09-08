/**
 * Injectable rate-limit check for the aggregator approval-token verify surface.
 *
 * Mirrors `support-rate.ts`: wraps the Redis fixed-window limiter so route tests
 * can vary the outcome without Redis. Unlike the support/public-submit limiters
 * this one is **fail-closed** (`failClosed: true`) — it guards the token-forgery
 * surface (read/decision/renew), so a downed Redis must NOT silently remove the
 * throttle. Keyed per client IP.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { consume } from './rate-limiter/index.js';

/** Verify attempts allowed per IP per window across read/decision/renew. */
export const APPROVAL_VERIFY_RATE_WINDOW_SECONDS = 60;
export const APPROVAL_VERIFY_RATE_MAX_PER_WINDOW = 20;

export interface ApprovalVerifyRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<ApprovalVerifyRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis-backed default). */
export function _setApprovalVerifyRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key from the approval-verify bucket.
 *
 * @param key - Identifier inside the bucket (the caller IP).
 * @returns Whether the attempt is allowed + retry-after seconds.
 */
export async function checkApprovalVerifyRate(key: string): Promise<ApprovalVerifyRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'approval-verify',
    key,
    windowSeconds: APPROVAL_VERIFY_RATE_WINDOW_SECONDS,
    max: APPROVAL_VERIFY_RATE_MAX_PER_WINDOW,
    failClosed: true,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
