/**
 * Resolved network config singleton for the worker app.
 *
 * Loaded once on first use from `AGGREGATOR_CONFIG_PATH`. The bulk row
 * processor uses it for identity fields, item_type and the array delimiter.
 *
 * @module apps/worker/services/network-config
 */

import path from 'node:path';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { resolveConfigPath } from '@aggregator-dpg/network-config/paths';
import { logger } from '../logger.js';

let cached: ResolvedNetworkConfig | null = null;
let inflight: Promise<ResolvedNetworkConfig> | null = null;

export async function getNetworkConfig(): Promise<ResolvedNetworkConfig> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const configPath = resolveConfigPath();
    const cacheDir =
      process.env.NETWORK_CONFIG_CACHE_DIR ?? path.join(path.dirname(configPath), '.cache');
    const loader = new FileNetworkConfigLoader({ configPath, cacheDir });
    const result = await loader.load();
    if (!result.success) {
      const message = failureMessage(result.error);
      logger.error({
        operation: 'network-config.load',
        status: 'failure',
        config_path: configPath,
        error: message,
      });
      throw new Error(`network-config load failed: ${message}`);
    }
    cached = result.value;
    if (cached.warnings && cached.warnings.length > 0) {
      logger.warn(
        {
          operation: 'network-config.load',
          status: 'skipped',
          finding: 'network_json_parts_dropped',
          warnings: cached.warnings,
        },
        'network.json: malformed optional parts were dropped',
      );
    }
    logger.info(
      {
        operation: 'network-config.load',
        status: 'success',
        network_id: cached.network.id,
        domain_ids: cached.domainIds,
      },
      'worker network config resolved',
    );
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Reads the message from a failed load's error.
 *
 * @param error - The loader's error value.
 * @returns The `message` string, or `unknown error` when there is none.
 */
function failureMessage(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : 'unknown error';
}

/** Test helper. */
export function _setNetworkConfig(cfg: ResolvedNetworkConfig | null): void {
  cached = cfg;
}
