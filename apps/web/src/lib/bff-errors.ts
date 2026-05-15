/**
 * Standardised BFF error responses.
 *
 * The 401 body is the contract the client `jsonFetch` wrapper relies on to
 * detect an expired session and force a re-login. Every BFF route that can
 * trip the `no active session` path should return `unauthorizedResponse()`
 * — not a bare `{ error: 'Unauthorized' }` payload — so the wrapper can
 * recognise the case uniformly.
 */

import { NextResponse } from 'next/server';

/**
 * Standard 401 body returned when the BFF session is missing or unable to
 * be refreshed (refresh token expired / revoked). The `code` field is the
 * stable contract — clients pattern-match on it.
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Unauthorized',
      code: 'NO_ACTIVE_SESSION',
      message:
        'No active session cookie was found, or your session has expired. Sign in again at /login and retry the request.',
      hint: 'The BFF requires a valid `sid` cookie; the upstream API call was not attempted.',
    },
    { status: 401 },
  );
}

/**
 * Standard 503 body returned when an upstream service (API, Keycloak, etc.)
 * is unreachable. Caller passes a short `service` label for the response
 * code and an optional `detail` string with low-level diagnostics.
 */
export function serviceUnavailableResponse(service: string, detail?: string): NextResponse {
  return NextResponse.json(
    {
      error: 'ServiceUnavailable',
      code: `${service.toUpperCase().replace(/-/g, '_')}_UPSTREAM_FAILED`,
      message: `The ${service} service is temporarily unreachable. Please try again shortly.`,
      detail: detail ?? 'unknown error',
    },
    { status: 503 },
  );
}
