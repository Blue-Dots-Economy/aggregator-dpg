/**
 * Shared client-side HTTP wrapper.
 *
 * Every BFF call from the browser goes through `jsonFetch`. It transparently:
 *   - sets the JSON content-type / Accept headers
 *   - includes credentials so the `sid` cookie travels
 *   - intercepts 401 `NO_ACTIVE_SESSION` responses and force-logs out the
 *     user (so a stale tab cannot keep showing pre-cached data after the
 *     refresh token has died)
 *
 * Standardised 401 body — see apps/web/src/lib/bff-errors.ts.
 */

let redirecting = false;

interface UnauthorizedBody {
  error?: unknown;
  code?: unknown;
}

/**
 * Returns true when the response body matches the standard
 * `NO_ACTIVE_SESSION` shape from `bff-errors.ts`.
 */
function isSessionExpired(body: unknown): body is UnauthorizedBody {
  if (!body || typeof body !== 'object') return false;
  const code = (body as UnauthorizedBody).code;
  return code === 'NO_ACTIVE_SESSION';
}

/**
 * Force a logout flow. Idempotent within the page lifetime — concurrent
 * 401s race once, then no-op until the redirect actually navigates away.
 */
function forceLogout(): void {
  if (redirecting) return;
  redirecting = true;
  if (typeof window === 'undefined') return;
  // Skip when already on the login flow.
  const path = window.location.pathname;
  if (path.startsWith('/login') || path.startsWith('/api/auth/')) {
    redirecting = false;
    return;
  }
  const ret = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/api/auth/logout?reason=expired&return=${ret}`;
}

/**
 * Fetch a BFF endpoint and parse JSON. Auto-redirects to logout when the
 * server reports `NO_ACTIVE_SESSION`.
 *
 * @throws When the response status is not OK (non-401, or 401 that isn't
 *   our standard session-expired body). The thrown Error contains the
 *   upstream status + text.
 */
export async function jsonFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'include',
  });

  if (res.status === 401) {
    // Try to parse body to confirm it's our session-expired shape; if so,
    // hand off to forceLogout. If not, surface as a normal error.
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as unknown;
    if (isSessionExpired(body)) {
      forceLogout();
      throw new Error('session expired');
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`request failed (${res.status}): ${text || res.statusText}`);
  }

  return (await res.json()) as T;
}

/**
 * Raw fetch for callers that need the `Response` object (e.g. binary
 * downloads). Still intercepts 401 NO_ACTIVE_SESSION.
 */
export async function fetchWithAuth(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    credentials: 'include',
  });
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as unknown;
    if (isSessionExpired(body)) {
      forceLogout();
      throw new Error('session expired');
    }
  }
  return res;
}
