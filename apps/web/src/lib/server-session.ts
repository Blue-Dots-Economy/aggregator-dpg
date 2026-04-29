/**
 * Server-side session accessor.
 *
 * Wraps the session-store lookup in React's `cache()` so every Server
 * Component in the same render tree shares one Redis hit per request.
 *
 * NOT a React context — this is a server-only helper. The browser-facing
 * AuthProvider lives in `auth-context.tsx` (legacy mock; will be replaced
 * once BFF is wired).
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { getSessionStore } from './session';
import { SESSION_COOKIE } from './cookies';
import type { SessionData } from './session';

/**
 * Loads the active session, if any, for the current request.
 *
 * @returns Session data or `null` when no valid `sid` cookie is present.
 */
export const getSession = cache(async (): Promise<SessionData | null> => {
  const sid = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  const result = await getSessionStore().get(sid);
  return result.ok ? result.value : null;
});
