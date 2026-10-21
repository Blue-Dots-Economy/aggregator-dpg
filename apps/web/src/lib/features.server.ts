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
import { logger } from './logger';

/** Deploy-time capability flags surfaced by `GET /v1/aggregator-config`. */
export interface AggregatorFeatures {
  custom_roles: boolean;
}

const FETCH_TIMEOUT_MS = 5000;

/** Fail-safe default when the api is unreachable or omits the field. */
const DEFAULT_FEATURES: AggregatorFeatures = { custom_roles: false };

/**
 * Reads the deploy-time capability flags from the aggregator api.
 *
 * Best-effort: on timeout, a non-2xx response, a malformed body, or an absent
 * `features` block, returns {@link DEFAULT_FEATURES} (everything off) so a
 * gated surface stays hidden. Never throws.
 *
 * @returns The resolved feature flags, or the fail-safe default.
 */
export async function getAggregatorFeatures(): Promise<AggregatorFeatures> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  const start = Date.now();
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({
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
    logger.warn({
      operation: 'features.getAggregatorFeatures',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      latency_ms: Date.now() - start,
    });
    return DEFAULT_FEATURES;
  }
}

/**
 * Whether the custom-roles capability is enabled for this deployment.
 *
 * @returns True when the api reports `features.custom_roles === true`.
 */
export async function customRolesEnabled(): Promise<boolean> {
  return (await getAggregatorFeatures()).custom_roles;
}
