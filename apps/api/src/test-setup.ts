/**
 * Vitest setup for `@aggregator-dpg/api` unit tests.
 *
 * Publishes a fresh in-memory identity store before every test, so no unit
 * test reaches Postgres through the login-recording paths (review link, first
 * approved request). `getIdentityStore()` returns it while no store was
 * injected explicitly (`_setIdentityStore(...)` still wins).
 *
 * Imports ONLY the dependency-free in-memory store: importing anything that
 * loads the API config here would freeze it before a test file sets the env
 * vars it reads at import time, and would interfere with tests that reset
 * modules.
 */
import { beforeEach } from 'vitest';
import { InMemoryIdentityStore } from './services/identity-store/memory.js';
import { TEST_IDENTITY_STORE_KEY } from './services/identity-store/test-hook.js';

beforeEach(() => {
  (globalThis as Record<string, unknown>)[TEST_IDENTITY_STORE_KEY] = new InMemoryIdentityStore();
});
