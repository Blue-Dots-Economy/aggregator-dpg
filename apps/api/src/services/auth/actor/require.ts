/**
 * Console route guard (`@aggregator-dpg/api`, user & org Phase 5).
 *
 * `requireActor` is the first statement of every `/v1/user/*` and `/v1/org/*`
 * handler (the repo's per-file wrapper pattern). It verifies the token,
 * refuses service accounts, and resolves the caller from the database.
 */

import type { FastifyRequest } from 'fastify';
import { authenticateAny, type AnyAuthContext } from '../access-token.js';
import { httpError } from '../../../errors/http-error.js';
import { getActorResolver } from './index.js';
import { enforceActorRouteAccess } from '../../authz/route-access.js';
import type { Actor } from './interface.js';

/** A verified, resolved caller. */
export interface ResolvedCaller {
  actor: Actor;
  auth: AnyAuthContext;
}

/** Options of {@link requireActor}. */
export interface RequireActorOptions {
  /**
   * Admit an approved coordinator. Off by default: every console route except
   * `user/read/me` is for admins only (design C7).
   */
  allowCoordinator?: boolean;
}

/**
 * Resolves the signed-in caller of a console route, or throws the HTTP error
 * the route answers with.
 *
 * @param req - The request.
 * @param opts - Whether coordinators are admitted.
 * @returns The caller.
 * @throws {HttpError} `UNAUTHORIZED` (no / bad token), `FORBIDDEN` (service
 *   account, wrong client, or a coordinator on an admin route),
 *   `USER_NOT_PROVISIONED`, `NOT_APPROVED` (coordinator not approved),
 *   `NOT_ORG_ADMIN` (admin without an active org), `DB_UNAVAILABLE`, and
 *   `FORBIDDEN` with `fields.permission` when RBAC enforces a missing
 *   capability.
 */
export async function requireActor(
  req: FastifyRequest,
  opts: RequireActorOptions = {},
): Promise<ResolvedCaller> {
  const auth = await authenticateAny(req);
  if (!auth.ok) {
    if (auth.error.code === 'AZP_NOT_ALLOWED') throw httpError('FORBIDDEN');
    throw httpError('UNAUTHORIZED', { detail: auth.error.message });
  }
  // A service account is told apart from a user on the same client by
  // `preferred_username`, never by `sub` (a UUID for both; apps/api/CLAUDE.md).
  if (auth.context.preferredUsername?.startsWith('service-account-')) {
    throw httpError('FORBIDDEN', { detail: 'console routes require a signed-in user' });
  }

  const resolved = await getActorResolver().resolve({
    subject: auth.context.subject,
    ...(auth.context.aggregatorId ? { aggregatorId: auth.context.aggregatorId } : {}),
  });
  if (!resolved.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(resolved.error.message),
      fields: { sub_operation: 'actorResolver.resolve' },
    });
  }
  const actor = resolved.value;
  if (!actor) throw httpError('USER_NOT_PROVISIONED');
  if (actor.userType === 'coordinator') {
    if (!actor.active) throw httpError('NOT_APPROVED');
    if (!opts.allowCoordinator) throw httpError('FORBIDDEN');
  } else if (!actor.active) {
    throw httpError('NOT_ORG_ADMIN');
  }
  // RBAC: the route's declared capability (`config.rbac`), on the actor just
  // resolved. A no-op with RBAC_MODE=off; logs in `log`; 403 in `enforce`.
  await enforceActorRouteAccess(req, actor);
  return { actor, auth: auth.context };
}
