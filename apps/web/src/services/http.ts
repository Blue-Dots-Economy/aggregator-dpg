/**
 * Client-side HTTP wrapper for BFF calls from the browser (web app).
 *
 * `jsonFetch` sets JSON headers, sends the session cookie, and logs the
 * user out on a 401 `NO_ACTIVE_SESSION` response (see `lib/bff-errors.ts`).
 */

import { z } from 'zod';
import { readApiError } from '../lib/api-error';
import { parseResponseBody, ResponseShapeError } from '../lib/response-shape-error';

let redirecting = false;

/** The 401 body that `bff-errors.ts` sends when the session has expired. */
const SessionExpiredBodySchema = z.object({ code: z.literal('NO_ACTIVE_SESSION') });

/**
 * TanStack Query `retry` rule: one retry, but none for a `ResponseShapeError`,
 * which would fail the same way again.
 *
 * @param failureCount - Failures so far for this query.
 * @param error - The latest failure.
 */
export function retryUnlessShapeError(failureCount: number, error: unknown): boolean {
  return !(error instanceof ResponseShapeError) && failureCount < 1;
}

/**
 * A BFF call that answered with a non-OK status.
 *
 * Carries the status and the API's error code. The message holds the status
 * only, never the response body, so it is safe to log but not meant for users:
 * map `code` to a translated message instead.
 */
export class HttpError extends Error {
  /** The HTTP status of the response. */
  readonly status: number;
  /** The API's `error.code`, when the body has the API's error shape. */
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(`request failed (${status})`);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Redirects to logout. Runs once per page, even with concurrent 401s. */
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
 * Fetches a BFF endpoint and parses the JSON response with `schema`.
 *
 * Redirects to logout when the server reports `NO_ACTIVE_SESSION`. Fields the
 * schema does not declare are dropped, unless the schema keeps them (`.passthrough()`).
 *
 * @param input - The request URL or object.
 * @param schema - The expected shape of an OK response body.
 * @param init - Extra fetch options; headers are merged.
 * @returns The parsed body.
 * @throws {HttpError} When the response is not OK.
 * @throws {ResponseShapeError} When an OK body is not JSON or does not match `schema`.
 */
export async function jsonFetch<S extends z.ZodTypeAny>(
  input: RequestInfo,
  schema: S,
  init?: RequestInit,
): Promise<z.output<S>> {
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
    // Log out only for the session-expired body; other 401s fall through as errors.
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (SessionExpiredBodySchema.safeParse(body).success) {
      forceLogout();
      throw new Error('session expired');
    }
  }

  if (!res.ok) {
    const apiError = await readApiError(res);
    throw new HttpError(res.status, apiError?.code);
  }

  return parseResponseBody(res, typeof input === 'string' ? input : input.url, schema);
}
