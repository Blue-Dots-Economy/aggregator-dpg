/**
 * Public surface and factory for the aggregator store.
 *
 * Returns a process-wide singleton. Tests override via `_setUserStore`.
 */

import type { UserStoreBase } from './interface.js';
import { PostgresUserStore } from './postgres.js';

let instance: UserStoreBase | null = null;

/**
 * Returns the shared aggregator store. Lazy-initialised on first call.
 */
export function getUserStore(): UserStoreBase {
  if (instance) return instance;
  instance = new PostgresUserStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setUserStore(s: UserStoreBase | null): void {
  instance = s;
}

export { UserStoreBase } from './interface.js';
export type { Aggregator, CreateAggregatorInput, StoreError, StoreResult } from './interface.js';
export { InMemoryUserStore } from './memory.js';
export { PostgresUserStore } from './postgres.js';
export { UserStoreFake, buildAggregator, buildCreateAggregatorInput } from './testing.js';
