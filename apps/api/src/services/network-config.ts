/**
 * Process-local singleton for the resolved aggregator + signalstack
 * network config. Loaded once on first access from
 * `AGGREGATOR_CONFIG_PATH` (default `/app/config/aggregator.config.yaml`)
 * and re-used by every route + service that needs to look up a domain's
 * identity selectors, item_type, brand label, etc.
 *
 * Tests inject a pinned config via `_setNetworkConfig`.
 *
 * @module apps/api/services/network-config
 */

import path from 'node:path';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { logger } from '../logger.js';

const DEFAULT_CONFIG_PATH = '/app/config/aggregator.config.yaml';

let cached: ResolvedNetworkConfig | null = null;
let inflight: Promise<ResolvedNetworkConfig> | null = null;

/**
 * Returns the resolved aggregator config. First call triggers the file
 * read + signalstack network.json fetch; subsequent calls return the
 * cached singleton. Throws on any unrecoverable failure so the api
 * fails loud at the route-binding stage instead of swallowing
 * configuration errors at request time.
 */
export async function getNetworkConfig(): Promise<ResolvedNetworkConfig> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const configPath = process.env.AGGREGATOR_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
    const cacheDir =
      process.env.NETWORK_CONFIG_CACHE_DIR ?? path.join(path.dirname(configPath), '.cache');
    const loader = new FileNetworkConfigLoader({ configPath, cacheDir });
    const result = await loader.load();
    if (!result.success) {
      const message =
        'error' in result && typeof result.error === 'object' && result.error
          ? ((result.error as { message?: string }).message ?? 'unknown error')
          : 'unknown error';
      logger.error({
        operation: 'network-config.load',
        status: 'failure',
        config_path: configPath,
        error: message,
      });
      throw new Error(`network-config load failed: ${message}`);
    }
    cached = result.value;
    logger.info(
      {
        operation: 'network-config.load',
        status: 'success',
        network_id: cached.network.id,
        domain_ids: cached.domainIds,
        brand: cached.aggregator.brand.short_name,
      },
      'aggregator network config resolved',
    );
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test helper — inject a fake config; pass null to force re-load. */
export function _setNetworkConfig(cfg: ResolvedNetworkConfig | null): void {
  cached = cfg;
}
