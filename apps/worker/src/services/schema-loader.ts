/**
 * Worker schema loader singleton.
 *
 * The hybrid resolution itself (participant ids from network-config, all other
 * ids from disk under `config/<network>/schemas/`) lives in
 * `@aggregator-dpg/schema-loader/network` and is shared with the API. This
 * module only binds it to the worker process's config and network-config
 * singleton, and owns the instance.
 */

import { NetworkSchemaLoader } from '@aggregator-dpg/schema-loader/network';
import { config } from '../config.js';
import { getNetworkConfig } from './network-config.js';

let instance: NetworkSchemaLoader | null = null;

/**
 * Returns the process-wide schema loader, creating it on first call.
 *
 * @returns The shared {@link NetworkSchemaLoader} bound to `SCHEMA_ROOT_DIR`.
 */
export function getSchemaLoader(): NetworkSchemaLoader {
  if (instance) return instance;
  instance = new NetworkSchemaLoader({
    rootDir: config.SCHEMA_ROOT_DIR,
    getNetworkConfig,
  });
  return instance;
}
