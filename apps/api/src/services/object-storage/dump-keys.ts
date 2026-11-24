/**
 * S3 keys of the Signals non-PII dump: `[<prefix>/]<network>/<instance_id>/<table>.ndjson.gz`,
 * one fixed key per table, overwritten on every export.
 *
 * @module apps/api/services/object-storage/dump-keys
 */

import { z } from 'zod';

/** Files served when `CAMPAIGN_DUMP_FILES` is unset. */
export const DEFAULT_DUMP_FILES = 'user,items,item_actions,aggregators,registration_links';

/** Parses `CAMPAIGN_DUMP_FILES`: comma-separated, unique, word characters only. */
export const dumpFilesSchema = z
  .string()
  .optional()
  .transform((raw) => (raw?.trim() || DEFAULT_DUMP_FILES).split(',').map((t) => t.trim()))
  .pipe(
    z
      .array(z.string().regex(/^\w+$/, 'file names may contain only letters, digits and _'))
      .refine((files) => new Set(files).size === files.length, 'file names must be unique'),
  );

/** Inputs that locate one deployment's dump within the bucket. */
export interface DumpLocation {
  /** Optional prefix; empty means keys start at the network. */
  prefix: string;
  /** Network id, from the aggregator config. */
  network: string;
  /** The Signals instance this deployment serves. */
  instanceId: string;
}

/**
 * Builds the key root of this deployment's dump; extra slashes in the prefix are dropped.
 *
 * @param opts - The dump location.
 * @returns The key root, with no leading or trailing slash.
 */
export function dumpKeyRoot(opts: DumpLocation): string {
  return [...opts.prefix.split('/'), opts.network, opts.instanceId]
    .filter((p) => p.length > 0)
    .join('/');
}

/**
 * Builds the key of each dump file.
 *
 * @param opts - The dump location.
 * @param files - File names to serve, from `CAMPAIGN_DUMP_FILES`.
 * @returns One entry per file, in the given order.
 */
export function dumpObjectKeys(
  opts: DumpLocation,
  files: readonly string[],
): Array<{ table: string; key: string }> {
  const root = dumpKeyRoot(opts);
  return files.map((table) => ({ table, key: `${root}/${table}.ndjson.gz` }));
}
