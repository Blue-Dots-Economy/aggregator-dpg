/**
 * Public surface + factory for the aggregator-org store.
 *
 * Returns a process-wide singleton. Tests override via `_setAggregatorOrgStore`.
 */

import type { AggregatorOrgStoreBase } from './interface.js';
import { PostgresAggregatorOrgStore } from './postgres.js';

let instance: AggregatorOrgStoreBase | null = null;

/** Returns the shared org store. Lazy-initialised on first call. */
export function getAggregatorOrgStore(): AggregatorOrgStoreBase {
  if (instance) return instance;
  instance = new PostgresAggregatorOrgStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setAggregatorOrgStore(s: AggregatorOrgStoreBase | null): void {
  instance = s;
}

export { AggregatorOrgStoreBase } from './interface.js';
export type {
  AggregatorOrg,
  CreateOrgInput,
  UpdateOrgPatch,
  OrgStoreError,
  OrgStoreResult,
} from './interface.js';
export { InMemoryAggregatorOrgStore } from './memory.js';
export { PostgresAggregatorOrgStore } from './postgres.js';
export { AggregatorOrgStoreFake, buildAggregatorOrg } from './testing.js';
