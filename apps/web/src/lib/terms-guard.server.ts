/**
 * Layout guard that sends a user with outstanding terms to the terms page (`@aggregator-dpg/web`).
 *
 * The coordinator portal and console layouts call it on every page. The
 * status read at login is in the session; a session without one (older than
 * this check, or whose login check failed) is checked again here.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './cookies';
import { logger } from './logger';
import { getSessionStore } from './session';
import { getSession } from './server-session';
import { ACCEPT_TERMS_PATH, fetchTermsStatus, type TermsStatus } from './terms-status.server';
import { getFreshAccessToken } from './upstream-client';

export { TERMS_ALLOWED_API_PATHS, isTermsAllowedApiPath } from './terms-status.server';

/**
 * Redirects to the terms page when the signed-in user still has to accept the terms.
 *
 * Fails open: when the status cannot be read the page loads and the
 * session is not marked outstanding, so `callApi` does not block it. Never redirects from the terms page itself.
 *
 * @param path - The current page path with its query, used as `returnTo`.
 * @throws {Error} Next.js's redirect signal when the terms are outstanding.
 */
export async function ensureTermsAccepted(path: string): Promise<void> {
  if (path.split('?')[0] === ACCEPT_TERMS_PATH) return;
  const session = await getSession();
  if (!session) return;

  let status: TermsStatus = session.termsStatus ?? 'unknown';
  if (status === 'unknown') {
    const accessToken = await getFreshAccessToken();
    if (!accessToken) return;
    status = (await fetchTermsStatus(accessToken)).status;
    await storeTermsStatus(status);
  }

  if (status === 'outstanding') {
    redirect(`${ACCEPT_TERMS_PATH}?returnTo=${encodeURIComponent(path)}`);
  }
}

/**
 * Saves a terms status in the current request's session. A failure is
 * logged and does not block the caller.
 *
 * @param status - The status just read or recorded.
 */
export async function storeTermsStatus(status: TermsStatus): Promise<void> {
  try {
    const sid = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!sid) return;
    const result = await getSessionStore().update(sid, { termsStatus: status });
    if (!result.ok) {
      logger.warn({ operation: 'terms.status.store', status: 'failure', code: result.error.code });
    }
  } catch (err) {
    logger.warn({
      operation: 'terms.status.store',
      status: 'failure',
      error: err instanceof Error ? err.name : 'UnknownError',
    });
  }
}
