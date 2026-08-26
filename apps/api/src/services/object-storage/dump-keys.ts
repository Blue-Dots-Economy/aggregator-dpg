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

/** Tables the exporter publishes, in the order the API reports them. */
export const DUMP_TABLES = ['user', 'items', 'item_actions'] as const;

/** One of the three exported tables. */
export type DumpTable = (typeof DUMP_TABLES)[number];

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
 * Builds the key prefix shared by this deployment's three dump objects.
 *
 * @param opts - The dump location.
 * @returns The key root, with no trailing slash.
 */
export function dumpKeyRoot(opts: DumpLocation): string {
  const prefix = opts.prefix.replace(/^\/+|\/+$/g, '');
  return [prefix, opts.network, opts.instanceId].filter((p) => p.length > 0).join('/');
}

/**
 * Builds the full key for every exported table.
 *
 * @param opts - The dump location.
 * @returns One entry per table, in {@link DUMP_TABLES} order.
 */
export function dumpObjectKeys(opts: DumpLocation): Array<{ table: DumpTable; key: string }> {
  const root = dumpKeyRoot(opts);
  return DUMP_TABLES.map((table) => ({ table, key: `${root}/${table}.ndjson.gz` }));
}
