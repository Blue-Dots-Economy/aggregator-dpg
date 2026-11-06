/**
 * Test-only hooks for the RBAC edge plumbing (`@aggregator-dpg/api`).
 *
 * The Vitest setup (`src/test-setup.ts`) publishes these before every unit
 * test, so loading RBAC in a test never reaches a real OPA or Redis:
 *
 * - `TEST_EDGE_FETCH_KEY`: the `fetch` the catalogue publisher uses (a recorder
 *   answering 204) when no `fetchImpl` is passed explicitly.
 * - `TEST_TOKEN_ROLES_OFF_KEY`: when true, a token-roles sync with the default
 *   dependencies does nothing; a test that checks the sync passes its own
 *   dependencies or clears the key.
 *
 * Never set in production. Dependency-free so the setup can import it.
 */
export const TEST_EDGE_FETCH_KEY = '__aggregatorDpgTestEdgeFetch';
export const TEST_TOKEN_ROLES_OFF_KEY = '__aggregatorDpgTestTokenRolesOff';

/** The recorder the setup installs under {@link TEST_EDGE_FETCH_KEY}. */
export interface EdgeFetchRecorder {
  /** Bodies of every request, parsed as JSON. */
  bodies: unknown[];
  /** The `fetch` to use; replace it to simulate a failing sidecar. */
  fetch: typeof fetch;
}

/** A recorder that answers every request with 204 and keeps its body. */
export function edgeFetchRecorder(): EdgeFetchRecorder {
  const rec: EdgeFetchRecorder = {
    bodies: [],
    fetch: (_url, init) => {
      rec.bodies.push(JSON.parse(String(init?.body ?? 'null')));
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  };
  return rec;
}

/**
 * The recorder the setup installed under {@link TEST_EDGE_FETCH_KEY}, if any.
 *
 * @returns The recorder, or `undefined` outside the unit-test setup.
 */
export function installedEdgeFetchRecorder(): EdgeFetchRecorder | undefined {
  const value: unknown = Reflect.get(globalThis, TEST_EDGE_FETCH_KEY);
  return isEdgeFetchRecorder(value) ? value : undefined;
}

/** Whether `value` has the shape of an {@link EdgeFetchRecorder}. */
function isEdgeFetchRecorder(value: unknown): value is EdgeFetchRecorder {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fetch' in value &&
    typeof value.fetch === 'function' &&
    'bodies' in value &&
    Array.isArray(value.bodies)
  );
}
