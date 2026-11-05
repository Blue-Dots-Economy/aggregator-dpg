/**
 * Public surface and factory for the identity store (`@aggregator-dpg/api`).
 * Returns a process-wide singleton; tests override it with `_setIdentityStore`.
 */

import { IdentityStoreBase } from './interface.js';
import { PostgresIdentityStore } from './postgres.js';
import { TEST_IDENTITY_STORE_KEY } from './test-hook.js';

let instance: IdentityStoreBase | null = null;

/**
 * Returns the shared identity store (lazy). An explicitly injected store wins;
 * otherwise, under the unit-test setup, the per-test in-memory store.
 * @throws {TypeError} When the test hook holds a value of another class.
 */
export function getIdentityStore(): IdentityStoreBase {
  if (instance) return instance;
  const testStore: unknown = Reflect.get(globalThis, TEST_IDENTITY_STORE_KEY);
  if (testStore instanceof IdentityStoreBase) return testStore;
  if (testStore !== undefined) {
    // Another module copy (for example after `vi.resetModules()`) fails `instanceof`.
    throw new TypeError('identity store test hook holds a value that is not a IdentityStoreBase');
  }
  instance = new PostgresIdentityStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setIdentityStore(s: IdentityStoreBase | null): void {
  instance = s;
}

export { IdentityStoreBase } from './interface.js';
export type { IdentityStoreError, IdentityStoreResult, LinkOutcome } from './interface.js';
export { InMemoryIdentityStore } from './memory.js';
export { PostgresIdentityStore } from './postgres.js';
