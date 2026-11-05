/**
 * Browser-side auth service for the web app.
 *
 * Calls only the BFF (`/api/auth/*`). Tokens stay server-side in Redis.
 */

import { z } from 'zod';
import { ResponseShapeError } from '../lib/response-shape-error';
import type { User } from '../types';

const ME_URL = '/api/auth/me';

/** `GET /api/auth/me`: the identity claims of the session. */
const AuthMeResponseSchema = z.object({
  user: z.object({
    sub: z.string(),
    email: z.string().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
  }),
});

/**
 * Fetches the active user from the BFF.
 *
 * @returns User profile or `null` if unauthenticated.
 * @throws {Error} When the request fails with a status other than 401.
 * @throws {ResponseShapeError} When an OK body is not JSON or does not match.
 */
export async function fetchCurrentUser(): Promise<User | null> {
  const res = await fetch(ME_URL, { credentials: 'include', cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ResponseShapeError(ME_URL, []);
  }
  const parsed = AuthMeResponseSchema.safeParse(body);
  if (!parsed.success) throw new ResponseShapeError(ME_URL, parsed.error.issues);
  const data = parsed.data;
  return {
    id: data.user.sub,
    name: data.user.name ?? data.user.email ?? data.user.phone ?? data.user.sub,
    org: data.user.email ?? '',
  };
}

/** Logs out through the BFF, which ends the session and the Keycloak session. */
export function logout(): void {
  window.location.href = '/api/auth/logout';
}

/**
 * Triggers BFF login — redirects to Keycloak.
 *
 * @param returnTo - Path to land on after successful auth.
 */
export function login(returnTo: string = '/'): void {
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}
