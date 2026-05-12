/**
 * Singleton FileSchemaLoader used by File Processor + Row Processor.
 *
 * Compiled validators are cached per (schema_id, version); a single
 * instance per worker is correct since schemas are immutable per version.
 */

import { FileSchemaLoader } from '@aggregator-dpg/schema-loader/file';
import { config } from '../config.js';

let instance: FileSchemaLoader | null = null;

export function getSchemaLoader(): FileSchemaLoader {
  if (instance) return instance;
  instance = new FileSchemaLoader({ rootDir: config.SCHEMA_ROOT_DIR });
  return instance;
}
