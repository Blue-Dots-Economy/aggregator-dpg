/**
 * S3 key derivation for the Signals non-PII dump (#692).
 *
 * The `signals-s3-export` cron writes ONE object per table at a FIXED key,
 * overwriting it in place every run:
 *
 *     [<prefix>/]<network>/<instance_id>/<table>.ndjson.gz
 *
 * There is no manifest and no dated run folder (they were removed upstream in
 * adhoc-scripts commits e153c43/d5e4a2d), so "latest" is not resolved at all —
 * these keys ARE the contract. Derivation is kept here, separate from the S3
 * client, so it is unit-testable without a bucket.
 *
 * @module apps/api/services/object-storage/dump-keys
 */

import { z } from 'zod';

export const DEFAULT_DUMP_FILES = 'user,items,item_actions';

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
 * Leading, trailing and repeated slashes in the configured prefix are dropped;
 * `network` and `instanceId` are used verbatim, so a malformed one produces a
 * key that 404s rather than being silently corrected into a different dataset.
 *
 * @param opts - The dump location.
 * @returns The key root, with no leading or trailing slash.
 */
export function dumpKeyRoot(opts: DumpLocation): string {
  // Split on `/` rather than regex-trimming the prefix. `/^\/+|\/+$/` is the
  // obvious trim, but its `\/+$` alternative is the shape static analysis
  // flags as super-linear under backtracking (sonar typescript:S8786) — V8
  // happens to handle it fine, so this is a smell fix, not a hot path. The
  // split also folds into the filter that already drops an empty prefix, and
  // collapses an interior `//` that the regex would have left in the key.
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
