/**
 * Public surface + factory for the RBAC catalogue store (`@aggregator-dpg/api`,
 * R4). Returns a process-wide singleton; tests override it with
 * `_setRbacCatalogue`.
 */

import { RbacCatalogueBase } from './interface.js';
import { PostgresRbacCatalogue } from './postgres.js';
import { TEST_RBAC_CATALOGUE_KEY } from './test-hook.js';

let instance: RbacCatalogueBase | null = null;

/**
 * Returns the shared catalogue store (lazy). An explicitly injected store wins;
 * otherwise, under the unit-test setup, the per-test in-memory store.
 *
 * @returns The catalogue store.
 * @throws {TypeError} When the test hook holds a value of another class.
 */
export function getRbacCatalogue(): RbacCatalogueBase {
  if (instance) return instance;
  const testStore: unknown = Reflect.get(globalThis, TEST_RBAC_CATALOGUE_KEY);
  if (testStore instanceof RbacCatalogueBase) return testStore;
  if (testStore !== undefined) {
    // Another module copy (for example after `vi.resetModules()`) fails `instanceof`.
    throw new TypeError('RBAC catalogue test hook holds a value that is not a RbacCatalogueBase');
  }
  instance = new PostgresRbacCatalogue();
  return instance;
}

/** Test helper — replace the singleton (`null` restores the default). */
export function _setRbacCatalogue(s: RbacCatalogueBase | null): void {
  instance = s;
}

export { RbacCatalogueBase } from './interface.js';
export type {
  CatalogueSnapshot,
  CatalogueStoreError,
  CatalogueStoreResult,
  StoredPermission,
} from './interface.js';
export { InMemoryRbacCatalogue } from './memory.js';
export { PostgresRbacCatalogue } from './postgres.js';
