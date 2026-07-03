/**
 * Injectable submit rate-limit check for the coordinator registration
 * endpoint (spec A6).
 *
 * Belongs to `@aggregator-dpg/api`. Wraps the Redis fixed-window limiter so
 * route handlers stay testable without Redis (the real limiter fails open and
 * needs a live connection); tests override via `_setSubmitRateChecker`.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface SubmitRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<SubmitRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis-backed default). */
export function _setSubmitRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key (typically `${ip}|${email}`) from the
 * coordinator-submit bucket.
 *
 * @param key - Identifier inside the bucket (per-IP and/or per-email).
 * @returns Whether the call is allowed + retry-after seconds.
 */
export async function checkSubmitRate(key: string): Promise<SubmitRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'coordinator-submit',
    key,
    windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
    max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
