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
 * @returns One entry per table, in {@link DUMP_TABLES} order.
 */
export function dumpObjectKeys(opts: DumpLocation): Array<{ table: DumpTable; key: string }> {
  const root = dumpKeyRoot(opts);
  return DUMP_TABLES.map((table) => ({ table, key: `${root}/${table}.ndjson.gz` }));
}
