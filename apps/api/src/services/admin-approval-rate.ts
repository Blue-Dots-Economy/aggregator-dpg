/**
 * Injectable rate-limit check for the `/admin/v1/aggregator-registrations/*`
 * approval routes (GITHUB-ISSUES-COMPILATION.md #9 — these routes had no
 * rate limiting at all, relying solely on Kong's global 10k req/min cap).
 *
 * Belongs to `@aggregator-dpg/api`. Same shape as `submit-rate.ts` but a
 * distinct Redis namespace + config knobs, since the admin routes need a
 * tighter per-IP limit than the public submit endpoint.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface AdminApprovalRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<AdminApprovalRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis-backed default). */
export function _setAdminApprovalRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key (typically the caller's IP) from the
 * admin-approval bucket.
 *
 * @param key - Identifier inside the bucket (per-IP).
 * @returns Whether the call is allowed + retry-after seconds.
 */
export async function checkAdminApprovalRate(key: string): Promise<AdminApprovalRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'admin-approval',
    key,
    windowSeconds: config.ADMIN_APPROVAL_RATE_WINDOW_SECONDS,
    max: config.ADMIN_APPROVAL_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
