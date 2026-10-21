/**
 * Test-only hook for the role-assignment store (`@aggregator-dpg/api`, RBAC).
 * The Vitest setup (`src/test-setup.ts`) publishes a fresh in-memory store
 * under this global key before every unit test; `getRoleStore()` uses it when
 * no store was injected explicitly. Never set in production.
 */
export const TEST_ROLE_STORE_KEY = '__aggregatorDpgTestRoleStore';
