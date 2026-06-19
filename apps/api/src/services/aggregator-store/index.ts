/**
 * Public surface and factory for the aggregator store.
 *
 * Returns a process-wide singleton. Tests override via `_setAggregatorStore`.
 */

import type { AggregatorStoreBase } from './interface.js';
import { PostgresAggregatorStore } from './postgres.js';

let instance: AggregatorStoreBase | null = null;

/**
 * Returns the shared aggregator store. Lazy-initialised on first call.
 */
export function getAggregatorStore(): AggregatorStoreBase {
  if (instance) return instance;
  instance = new PostgresAggregatorStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setAggregatorStore(s: AggregatorStoreBase | null): void {
  instance = s;
}

export { AggregatorStoreBase } from './interface.js';
export type { Aggregator, CreateAggregatorInput, StoreError, StoreResult } from './interface.js';
export { InMemoryAggregatorStore } from './memory.js';
export { PostgresAggregatorStore } from './postgres.js';
export { AggregatorStoreFake, buildAggregator, buildCreateAggregatorInput } from './testing.js';
