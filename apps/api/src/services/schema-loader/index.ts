/**
 * Singleton FileSchemaLoader for the API process.
 *
 * Used on the link-submit hot path to validate request bodies against the
 * participant-{seeker,provider} JSON Schema. Compiled Ajv validators are
 * cached per (schema_id, version) for the lifetime of the process.
 */

import { FileSchemaLoader } from '@aggregator-dpg/schema-loader/file';
import { config } from '../../config.js';

let instance: FileSchemaLoader | null = null;

export function getSchemaLoader(): FileSchemaLoader {
  if (instance) return instance;
  instance = new FileSchemaLoader({ rootDir: config.SCHEMA_ROOT_DIR });
  return instance;
}

/** Test helper — replace the singleton with a fake loader. */
export function _setSchemaLoader(loader: FileSchemaLoader | null): void {
  instance = loader;
}
