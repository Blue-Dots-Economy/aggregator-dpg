/**
 * Public surface and factory for the aggregator profile store.
 */

import type { AggregatorProfileStoreBase } from './interface.js';
import { PostgresAggregatorProfileStore } from './postgres.js';

let instance: AggregatorProfileStoreBase | null = null;

/**
 * Returns the shared aggregator profile store. Lazy-initialised on first call.
 */
export function getAggregatorProfileStore(): AggregatorProfileStoreBase {
  if (instance) return instance;
  instance = new PostgresAggregatorProfileStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setAggregatorProfileStore(s: AggregatorProfileStoreBase | null): void {
  instance = s;
}

export { AggregatorProfileStoreBase } from './interface.js';
export type {
  AggregatorProfile,
  CreateAggregatorProfileInput,
  UpdateAggregatorProfileInput,
  ProfileStoreError,
  ProfileStoreResult,
} from './interface.js';
export { InMemoryAggregatorProfileStore } from './memory.js';
export { PostgresAggregatorProfileStore } from './postgres.js';
export {
  AggregatorProfileStoreFake,
  buildAggregatorProfile,
  buildCreateAggregatorProfileInput,
} from './testing.js';
