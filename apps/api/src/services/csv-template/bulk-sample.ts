/**
 * Curated bulk-upload sample loader. A network may ship a hand-curated,
 * data-complete sample CSV alongside its config
 * (`<config-dir>/bulk-samples/<participant_type>.csv`), so the "download
 * template" action returns a real, valid file an operator can edit in place
 * rather than a synthesised one-row template. Networks without a curated
 * sample fall back to the schema-generated template (`buildCsvTemplate`).
 *
 * @module apps/api/services/csv-template/bulk-sample
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../logger.js';

const DEFAULT_CONFIG_PATH = '/app/config/aggregator.config.yaml';

/**
 * Resolves the on-disk path of the curated sample CSV for a participant type,
 * relative to the active network config directory (the sample lives beside
 * `aggregator.config.yaml`, mirroring how `brand.json` is resolved).
 *
 * @param participantType - Validated participant domain id (e.g. `seeker`).
 * @param configPath - Active aggregator config path; defaults to the
 *   `AGGREGATOR_CONFIG_PATH` env value.
 * @returns Path to the candidate sample CSV.
 */
export function bulkSamplePath(
  participantType: string,
  configPath: string = process.env.AGGREGATOR_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
): string {
  return path.join(path.dirname(configPath), 'bulk-samples', `${participantType}.csv`);
}

/**
 * Reads the curated sample CSV for a participant type, when one ships with the
 * active network config. Returns null when no curated sample exists (the
 * caller then falls back to the generated template) or on any read error —
 * never throws, so the template endpoint stays available.
 *
 * @param participantType - Validated participant domain id.
 * @returns The CSV text, or null when no curated sample is available.
 */
export async function readBulkSample(participantType: string): Promise<string | null> {
  const file = bulkSamplePath(participantType);
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.error({
        operation: 'csv-template.readBulkSample',
        status: 'failure',
        participant_type: participantType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}
