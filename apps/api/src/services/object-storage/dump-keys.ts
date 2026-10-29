/**
 * S3 key derivation for the Signals non-PII dump (`@aggregator-dpg/api`).
 *
 * The `signals-s3-export` cron writes one object per table at a fixed key,
 * overwriting it every run:
 *
 *     [<prefix>/]<network>/<instance_id>/<table>.ndjson.gz
 *
 * There is no manifest or dated folder; these keys are the contract.
 *
 * @module apps/api/services/object-storage/dump-keys
 */

import { z } from 'zod';

export const DEFAULT_DUMP_FILES = 'user,items,item_actions,aggregators';

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
  /** Optional containing prefix; empty means keys start at the network segment. */
  prefix: string;
  /** Network id, from the resolved aggregator config — never from env. */
  network: string;
  /** The Signals instance this deployment serves. */
  instanceId: string;
}

/**
 * Builds the key prefix shared by this deployment's dump objects.
 *
 * Leading, trailing and repeated slashes in the prefix are dropped. `network`
 * and `instanceId` are used as-is, so a malformed value gives a key that 404s.
 *
 * @param opts - The dump location.
 * @returns The key root, with no leading or trailing slash.
 */
export function dumpKeyRoot(opts: DumpLocation): string {
  // Split on `/` instead of a regex trim, which static analysis flags as super-linear.
  return [...opts.prefix.split('/'), opts.network, opts.instanceId]
    .filter((p) => p.length > 0)
    .join('/');
}

/**
 * Builds the full key for every exported table.
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
