/**
 * Auth helpers for API route handlers.
 *
 * `requireSession()` returns the active session or a 401 Response — call from
 * any handler under `app/api/(authed)/*`.
 */

import { NextResponse } from 'next/server';
import { getSession } from './server-session';
import type { SessionData } from './session';

export class UnauthorizedError extends Error {
  readonly response: NextResponse;
  constructor() {
    super('unauthorized');
    this.response = NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

/**
 * Loads the active session or throws an `UnauthorizedError` whose `.response`
 * is a ready-to-return 401.
 *
 * Pattern in route handlers:
 * ```
 * try {
 *   const s = await requireSession();
 *   // ...
 * } catch (e) {
 *   if (e instanceof UnauthorizedError) return e.response;
 *   throw e;
 * }
 * ```
 *
 * @returns Active session data.
 * @throws {UnauthorizedError} If no session is present.
 */
export async function requireSession(): Promise<SessionData> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s;
}
