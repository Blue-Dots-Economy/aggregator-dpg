/**
 * Server-side read of the aggregator's deploy-time capability flags.
 *
 * The api is the single source of truth: `GET /v1/aggregator-config` always
 * returns `features: { custom_roles: boolean }`. Server components (the console
 * layout + roles page) and the role-mutation BFF proxies read the flag from
 * here so the custom-roles capability can be turned off at deploy time without
 * a web rebuild or any `NEXT_PUBLIC_*` var. Fails safe to `false` so a
 * transient api problem hides the admin surface rather than exposing it.
 *
 * @module apps/web/src/lib/features.server
 */

import 'server-only';
import { cache } from 'react';
import { logger } from './logger';

/** Deploy-time capability flags surfaced by `GET /v1/aggregator-config`. */
export interface AggregatorFeatures {
  custom_roles: boolean;
}

const FETCH_TIMEOUT_MS = 5000;

/** Fail-safe default when the api is unreachable or omits the field. */
const DEFAULT_FEATURES: AggregatorFeatures = { custom_roles: false };

/**
 * Logs a warning without ever throwing.
 *
 * The logger writes through a transport worker, and that worker can exit
 * under the dev server — a `logger.warn` inside the catch below then threw
 * `the worker has exited`, which escalated a recoverable fetch failure into an
 * uncaught exception and a spurious 404 on the role-mutation proxies. The
 * fail-safe return must survive a broken logger.
 *
 * @param payload - Structured log fields.
 */
function warnSafe(payload: Record<string, unknown>): void {
  try {
    logger.warn(payload);
  } catch {
    /* logging must never break the request */
  }
}

/**
 * Reads the deploy-time capability flags from the aggregator api.
 *
 * Best-effort: on timeout, a non-2xx response, a malformed body, or an absent
 * `features` block, returns {@link DEFAULT_FEATURES} (everything off) so a
 * gated surface stays hidden. Never throws.
 *
 * Wrapped in React's `cache()` (as `server-session.ts` does) so the console
 * layout, the roles page and the role-mutation proxies share one upstream call
 * per server request instead of each paying the fetch — a slow api then adds
 * its latency once, not N times, to a render.
 *
 * @returns The resolved feature flags, or the fail-safe default.
 */
export const getAggregatorFeatures = cache(
  async function getAggregatorFeatures(): Promise<AggregatorFeatures> {
    const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const start = Date.now();
    try {
      const res = await fetch(`${base}/v1/aggregator-config`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        warnSafe({
          operation: 'features.getAggregatorFeatures',
          status: 'failure',
          error: `HTTP ${res.status}`,
          latency_ms: Date.now() - start,
        });
        return DEFAULT_FEATURES;
      }
      const cfg = (await res.json()) as { features?: { custom_roles?: unknown } };
      return { custom_roles: cfg.features?.custom_roles === true };
    } catch (err) {
      warnSafe({
        operation: 'features.getAggregatorFeatures',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      });
      return DEFAULT_FEATURES;
    }
  },
);

/**
 * Whether the custom-roles capability is enabled for this deployment.
 *
 * @returns True when the api reports `features.custom_roles === true`.
 */
export async function customRolesEnabled(): Promise<boolean> {
  return (await getAggregatorFeatures()).custom_roles;
}
