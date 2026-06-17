/**
 * Server-side aggregator config cache.
 *
 * Wraps the upstream `/v1/aggregator-config` fetch in Next.js
 * `unstable_cache` so all server components (layout metadata, register
 * page, etc.) share a single cached result per 5-minute window — rather
 * than each firing its own uncached request on every page render.
 *
 * The config is static between deploys (from aggregator.config.yaml +
 * upstream network.json), so a 5-minute TTL is conservative.
 */

import { unstable_cache } from 'next/cache';
import type { AggregatorConfigPayload } from '@/hooks/useAggregatorConfig';

async function fetchAggregatorConfig(): Promise<AggregatorConfigPayload | null> {
  const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${base}/v1/aggregator-config`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as AggregatorConfigPayload;
  } catch {
    return null;
  }
}

/**
 * Returns the resolved aggregator config, cached for 5 minutes across
 * all server components in the same Next.js process.
 *
 * Returns `null` when the API is unreachable — callers should fall back
 * to static defaults.
 */
export const getServerAggregatorConfig = unstable_cache(
  fetchAggregatorConfig,
  ['aggregator-config-server'],
  { revalidate: 300, tags: ['aggregator-config'] },
);
