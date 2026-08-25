/**
 * Injectable rate-limit check for the contact-support endpoint (#551).
 *
 * Mirrors `submit-rate.ts`: wraps the Redis fixed-window limiter so route tests
 * can vary the outcome without Redis (the real limiter fails open, so an
 * un-overridden test would always see "allowed" and the 429 path would be
 * untestable).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { consume } from './rate-limiter/index.js';

/** Submissions allowed per coordinator per window — the endpoint takes multi-MB uploads. */
export const SUPPORT_RATE_WINDOW_SECONDS = 3600;
export const SUPPORT_RATE_MAX_PER_WINDOW = 5;

export interface SupportRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<SupportRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis-backed default). */
export function _setSupportRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key from the support-submit bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the submission is allowed + retry-after seconds.
 */
export async function checkSupportRate(key: string): Promise<SupportRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'support-submit',
    key,
    windowSeconds: SUPPORT_RATE_WINDOW_SECONDS,
    max: SUPPORT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
