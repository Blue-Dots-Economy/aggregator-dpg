/**
 * Public surface + factory for the grant store (`@aggregator-dpg/api`, RBAC
 * R3). Returns a process-wide singleton; tests override it with
 * `_setGrantStore`.
 */

import type { GrantStoreBase } from './interface.js';
import { PostgresGrantStore } from './postgres.js';
import { TEST_GRANT_STORE_KEY } from './test-hook.js';

let instance: GrantStoreBase | null = null;

/**
 * Returns the shared grant store (lazy). An explicitly injected store wins;
 * otherwise, under the unit-test setup, the per-test in-memory store.
 */
export function getGrantStore(): GrantStoreBase {
  if (instance) return instance;
  const testStore = (globalThis as Record<string, unknown>)[TEST_GRANT_STORE_KEY];
  if (testStore) return testStore as GrantStoreBase;
  instance = new PostgresGrantStore();
  return instance;
}

/** Test helper — replace the singleton (`null` restores the default). */
export function _setGrantStore(s: GrantStoreBase | null): void {
  instance = s;
}

export { GrantStoreBase } from './interface.js';
export type {
  AuditEntry,
  CreateGrantInput,
  GrantStoreError,
  GrantStoreResult,
  PermissionGrant,
} from './interface.js';
export { InMemoryGrantStore } from './memory.js';
export { PostgresGrantStore } from './postgres.js';
