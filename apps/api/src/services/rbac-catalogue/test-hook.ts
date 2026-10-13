/**
 * Test-only hook for the RBAC catalogue store (`@aggregator-dpg/api`, R4). The
 * Vitest setup (`src/test-setup.ts`) publishes a fresh in-memory catalogue
 * under this global key before every unit test; `getRbacCatalogue()` uses it
 * when no store was injected explicitly. Never set in production.
 */
export const TEST_RBAC_CATALOGUE_KEY = '__aggregatorDpgTestRbacCatalogue';
