/**
 * Unit tests for the test-hook branch of the store getters (`@aggregator-dpg/api`).
 *
 * The unit-test setup puts an in-memory store under a global key. A value of
 * another class, such as a store from a module copy loaded after
 * `vi.resetModules()`, must stop the getter instead of reaching Postgres.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setIdentityStore, getIdentityStore } from '../identity-store/index.js';
import { TEST_IDENTITY_STORE_KEY } from '../identity-store/test-hook.js';
import { InMemoryIdentityStore } from '../identity-store/memory.js';
import { _setRoleStore, getRoleStore } from '../role-store/index.js';
import { TEST_ROLE_STORE_KEY } from '../role-store/test-hook.js';
import { InMemoryRoleStore } from '../role-store/memory.js';
import { _setRbacCatalogue, getRbacCatalogue } from '../rbac-catalogue/index.js';
import { TEST_RBAC_CATALOGUE_KEY } from '../rbac-catalogue/test-hook.js';
import { InMemoryRbacCatalogue } from '../rbac-catalogue/memory.js';

const cases = [
  {
    name: 'identity store',
    key: TEST_IDENTITY_STORE_KEY,
    get: getIdentityStore,
    reset: () => _setIdentityStore(null),
    make: () => new InMemoryIdentityStore(),
  },
  {
    name: 'role store',
    key: TEST_ROLE_STORE_KEY,
    get: getRoleStore,
    reset: () => _setRoleStore(null),
    make: () => new InMemoryRoleStore(),
  },
  {
    name: 'RBAC catalogue',
    key: TEST_RBAC_CATALOGUE_KEY,
    get: getRbacCatalogue,
    reset: () => _setRbacCatalogue(null),
    make: () => new InMemoryRbacCatalogue(),
  },
];

describe.each(cases)('$name getter', ({ key, get, reset, make }) => {
  afterEach(() => {
    reset();
  });

  it('returns the store under the test hook', () => {
    reset();
    const store = make();
    Reflect.set(globalThis, key, store);
    expect(get()).toBe(store);
  });

  it('throws when the test hook holds a value of another class', () => {
    reset();
    Reflect.set(globalThis, key, { load: () => undefined });
    expect(() => get()).toThrow(/test hook/);
  });
});
