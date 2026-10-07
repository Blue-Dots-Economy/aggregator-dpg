/**
 * Test-only hook for the identity store (`@aggregator-dpg/api`). The Vitest
 * setup (`src/test-setup.ts`) publishes a fresh in-memory store under this
 * global key before every unit test; `getIdentityStore()` uses it when no
 * store was injected explicitly. Never set in production.
 */
export const TEST_IDENTITY_STORE_KEY = '__aggregatorDpgTestIdentityStore';
