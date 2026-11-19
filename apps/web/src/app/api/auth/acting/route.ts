/**
 * Switches an org owner into and out of acting as their own coordinator account.
 *
 * The acting account is kept in the server-side session; `callApi` names it in
 * the acting-account header on every API call made with the user's token.
 *
 * POST   /api/auth/acting `{ accountId }` → 200 `{ redirect: '/onboarding' }` | 400 | 401 | 403 | 409 `ACTING_NOT_READY`
 * DELETE /api/auth/acting?returnTo=<path> → 303 to `returnTo` (same-origin path) or `/console`
 * GET    /api/auth/acting/leave?returnTo=&reason= → the same, for server redirects and links
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ACTING_ROLE_PREFIX } from '@aggregator-dpg/rbac';
import { MeResponseSchema } from '@aggregator-dpg/shared-primitives/user-org';
import { SESSION_COOKIE } from '@/lib/cookies';
import { getSessionStore } from '@/lib/session';
import { callApi, refreshAccessToken } from '@/lib/upstream-client';
import { unauthorizedResponse, serviceUnavailableResponse } from '@/lib/bff-errors';
import { rejectCrossSite } from '@/lib/same-origin';
import { endActing } from '@/lib/acting-session.server';
import { decodeJwtClaims } from '@/lib/jwt';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/** Where the owner works once acting. */
const ACTING_HOME = '/onboarding';

const BodySchema = z.object({ accountId: z.guid() });

/** Error body in the API's envelope, so the console client reads its `code`. */
function errorResponse(status: number, code: string, title: string): NextResponse {
  return NextResponse.json({ error: { code, title } }, { status });
}

/** The `403` for an account the owner may not act as. */
function notAllowed(): NextResponse {
  return errorResponse(403, 'ACTING_NOT_ALLOWED', 'Request refused');
}

/**
 * True when the token's `roles` claim holds an acting entry for the account.
 * A token with no `roles` claim at all passes: RBAC is off, so the edge,
 * which needs the entry, is off too. The API still checks the account.
 */
function tokenCanActAs(accessToken: string, accountId: string): boolean {
  const claims = decodeJwtClaims(accessToken);
  if (claims && !('roles' in claims)) return true;
  const roles = claims?.['roles'];
  const prefix = `${ACTING_ROLE_PREFIX}${accountId}:`;
  return Array.isArray(roles) && roles.some((r) => typeof r === 'string' && r.startsWith(prefix));
}

/**
 * Starts acting as the owner's own coordinator account.
 *
 * Checks with `/me` (read as the owner, without the acting-account header)
 * that the account is the owner's own, refreshes the token so it carries the
 * account's tagged roles, then stores the account and drops the console actor cache.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const refused = rejectCrossSite(req);
  if (refused) return refused;

  const sid = req.cookies.get(SESSION_COOKIE)?.value;
  const store = getSessionStore();
  if (!sid || !(await store.get(sid)).ok) return unauthorizedResponse();

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return errorResponse(400, 'SCHEMA_VALIDATION', 'Invalid request');
  const { accountId } = body.data;

  let res: Response;
  try {
    res = await callApi('/v1/user/read/me', { method: 'GET', asSignedInAccount: true });
  } catch (err) {
    if (err instanceof Error && err.message === 'no active session') return unauthorizedResponse();
    logger.error({
      operation: 'auth.acting.start',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
    });
    return serviceUnavailableResponse('api');
  }
  if (res.status === 401) return unauthorizedResponse();
  if (res.status === 403) return notAllowed();
  if (!res.ok) return serviceUnavailableResponse('api');
  const me = MeResponseSchema.safeParse(await res.json().catch(() => null));
  if (!me.success) return serviceUnavailableResponse('api', 'unexpected /me response');
  if (me.data.own_coordinator_account_id !== accountId) return notAllowed();

  const accessToken = await refreshAccessToken();
  if (!accessToken) return unauthorizedResponse();
  if (!tokenCanActAs(accessToken, accountId)) {
    logger.warn({ operation: 'auth.acting.start', status: 'skipped', reason: 'acting_not_ready' });
    return errorResponse(409, 'ACTING_NOT_READY', 'Your coordinator account is not ready yet');
  }

  const updated = await store.update(sid, { actingAccountId: accountId, consoleActor: undefined });
  if (!updated.ok) return unauthorizedResponse();
  logger.info({ operation: 'auth.acting.start', status: 'success' });
  return NextResponse.json({ redirect: ACTING_HOME });
}

/**
 * Stops acting and returns to the console, or to a same-origin `returnTo` path.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  return endActing(req);
}
