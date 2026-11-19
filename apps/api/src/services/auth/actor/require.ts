/**
 * Console route guard, in the aggregator API (`@aggregator-dpg/api`).
 *
 * `requireActor` is the first call in every `/v1/user/*` and `/v1/org/*`
 * handler. It verifies the token, refuses service accounts, and resolves the
 * caller from the database.
 */

import type { FastifyRequest } from 'fastify';
import { authenticateAny, type AnyAuthContext } from '../access-token.js';
import { httpError } from '../../../errors/http-error.js';
import { ACTING_INVALID_DETAIL, logActing, readActingHeader } from '../acting.js';
import { getActorResolver } from './resolver.js';
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
   * `user/read/me` is for admins only.
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
 *   `NOT_ORG_ADMIN` (admin without an active org), `ACTING_ACCOUNT_INVALID`
 *   (an `x-acting-account` this login may not use), `DB_UNAVAILABLE`, and
 *   `FORBIDDEN` with `fields.permission` when RBAC enforces a missing
 *   capability.
 */
export async function requireActor(
  req: FastifyRequest,
  opts: RequireActorOptions = {},
): Promise<ResolvedCaller> {
  const auth = await verifiedUser(req);
  const acting = readActingHeader(req);
  if (acting.kind === 'malformed') {
    logActing('MALFORMED');
    throw httpError('ACTING_ACCOUNT_INVALID', { detail: ACTING_INVALID_DETAIL });
  }
  const actor = await resolveActor(auth, acting.kind === 'account' ? acting.id : null);
  assertAdmitted(actor, opts);
  return { actor, auth };
}

/**
 * Verifies the token and refuses a service account.
 *
 * @throws {HttpError} `UNAUTHORIZED` or `FORBIDDEN`.
 */
async function verifiedUser(req: FastifyRequest): Promise<AnyAuthContext> {
  const auth = await authenticateAny(req);
  if (!auth.ok) {
    if (auth.error.code === 'AZP_NOT_ALLOWED') throw httpError('FORBIDDEN');
    throw httpError('UNAUTHORIZED', { detail: auth.error.message });
  }
  // Tell a service account from a user by `preferred_username`, never by `sub`
  // (a UUID for both).
  if (auth.context.preferredUsername?.startsWith('service-account-')) {
    throw httpError('FORBIDDEN', { detail: 'console routes require a signed-in user' });
  }
  return auth.context;
}

/**
 * Resolves the caller's account from the database.
 *
 * @throws {HttpError} `ACTING_ACCOUNT_INVALID`, `DB_UNAVAILABLE` or `USER_NOT_PROVISIONED`.
 */
async function resolveActor(auth: AnyAuthContext, actingAccountId: string | null): Promise<Actor> {
  const resolved = await getActorResolver().resolve({
    subject: auth.subject,
    ...(auth.aggregatorId ? { aggregatorId: auth.aggregatorId } : {}),
    ...(actingAccountId === null ? {} : { actingAccountId }),
  });
  if (!resolved.ok) {
    if (resolved.error.code === 'ACTING_ACCOUNT_INVALID') {
      throw httpError('ACTING_ACCOUNT_INVALID', { detail: ACTING_INVALID_DETAIL });
    }
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(resolved.error.message),
      fields: { sub_operation: 'actorResolver.resolve' },
    });
  }
  if (!resolved.value) throw httpError('USER_NOT_PROVISIONED');
  return resolved.value;
}

/**
 * Refuses an account the route does not admit.
 *
 * @throws {HttpError} `NOT_APPROVED`, `FORBIDDEN` or `NOT_ORG_ADMIN`.
 */
function assertAdmitted(actor: Actor, opts: RequireActorOptions): void {
  if (actor.userType === 'coordinator') {
    if (!actor.active) throw httpError('NOT_APPROVED');
    if (!opts.allowCoordinator) throw httpError('FORBIDDEN');
  } else if (!actor.active) {
    throw httpError('NOT_ORG_ADMIN');
  }
}
