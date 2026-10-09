/**
 * Test-only hook for the grant store (`@aggregator-dpg/api`, RBAC R3). The
 * Vitest setup (`src/test-setup.ts`) publishes a fresh in-memory store under
 * this global key before every unit test; `getGrantStore()` uses it when no
 * store was injected explicitly. Never set in production.
 */
export const TEST_GRANT_STORE_KEY = '__aggregatorDpgTestGrantStore';
