/**
 * Invite-link checks shared by the invite read and accept routes of `@aggregator-dpg/api`.
 *
 * An invite link is usable when its token verifies for the expected role, its
 * row is still pending and unexpired, and the inviting org is the root or an
 * active, non-Default aggregator org.
 */

import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { InviteReadQuerySchema } from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { callerFromAny, recordRouteCaller } from '../services/authz/index.js';
import { verifyInviteToken, type InviteRole } from '../services/invite-token.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';

/** A usable invite and the org it was sent from. */
export interface UsableInvite {
  jti: string;
  role: InviteRole;
  /** The invited address, lower-cased. */
  email: string;
  expiresAt: Date;
  /** The org the coordinator joins, or the parent of the invited org. */
  org: { id: string; name: string; isRoot: boolean };
}

/** Throws `DB_UNAVAILABLE` naming the failed store call. */
function dbDown(subOperation: string, message: string): never {
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(message),
    fields: { sub_operation: subOperation },
  });
}

/**
 * Resolves the org an invite was sent from: the root or an active, non-Default aggregator org.
 *
 * @throws {HttpError} TARGET_ORG_INACTIVE or DB_UNAVAILABLE.
 */
async function inviteOrg(orgId: string): Promise<UsableInvite['org']> {
  const store = getOrganisationStore();
  const found = await store.findById(orgId);
  if (!found.ok) dbDown('orgStore.findById', found.error.message);
  if (found.value) {
    if (found.value.status !== 'active' || found.value.isDefault) {
      throw httpError('TARGET_ORG_INACTIVE');
    }
    return { id: found.value.id, name: found.value.displayName, isRoot: false };
  }
  const root = await store.findRoot();
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  if (root.value?.id !== orgId) throw httpError('TARGET_ORG_INACTIVE');
  return { id: root.value.id, name: root.value.displayName, isRoot: true };
}

/**
 * Checks an invite link without using it up.
 *
 * @param token - The invite token from the link.
 * @param role - The role the calling route serves.
 * @returns The invite and its org.
 * @throws {HttpError} INVITE_INVALID, INVITE_EXPIRED, INVITE_ALREADY_USED, TARGET_ORG_INACTIVE or DB_UNAVAILABLE.
 */
export async function usableInvite(token: string, role: InviteRole): Promise<UsableInvite> {
  const verified = await verifyInviteToken(token);
  if (!verified.ok) {
    throw httpError(verified.error.code === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_INVALID');
  }
  if (verified.role !== role) throw httpError('INVITE_INVALID');
  const row = await getRegistrationInvitesStore().findByJti(verified.jti);
  if (!row.ok) dbDown('inviteStore.findByJti', row.error.message);
  const stored = row.value;
  if (stored?.parentOrgId !== verified.org || stored.status === 'revoked') {
    throw httpError('INVITE_INVALID');
  }
  if (stored.status === 'consumed') throw httpError('INVITE_ALREADY_USED');
  if (stored.status === 'expired' || stored.expiresAt.getTime() <= Date.now()) {
    throw httpError('INVITE_EXPIRED');
  }
  const org = await inviteOrg(verified.org);
  if (org.isRoot && role === 'coordinator') throw httpError('TARGET_ORG_INACTIVE');
  return {
    jti: verified.jti,
    role,
    email: verified.email.trim().toLowerCase(),
    expiresAt: stored.expiresAt,
    org,
  };
}

/**
 * Claims a usable invite (`pending` to `consumed`) so one link registers at most once.
 *
 * @throws {HttpError} INVITE_ALREADY_USED or DB_UNAVAILABLE.
 */
export async function claimInvite(jti: string): Promise<void> {
  const claimed = await getRegistrationInvitesStore().consume(jti);
  if (!claimed.ok) dbDown('inviteStore.consume', claimed.error.message);
  if (claimed.value === null) throw httpError('INVITE_ALREADY_USED');
}

/**
 * Gives a claimed invite back after a registration that did not complete; a failure is logged.
 *
 * @param jti - The claimed invite's id.
 * @param log - Request-scoped logger.
 */
export async function releaseInvite(jti: string, log: FastifyBaseLogger): Promise<void> {
  const released = await getRegistrationInvitesStore().release(jti);
  if (!released.ok || released.value === null) {
    log.warn(
      { status: 'failure', sub_operation: 'inviteStore.release', invite_jti: jti },
      'invite release after an incomplete registration did not commit',
    );
  }
}

/**
 * Builds the handler of `GET /v1/{user,org}/invite/read`: checks the link without using it up.
 *
 * @param role - The role the route serves.
 * @returns The route handler; the BFF calls it with a service-account token.
 */
export function inviteReadHandler(
  role: InviteRole,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (req, reply) => {
    await authenticateCaller(req);
    const { token } = req.query as z.infer<typeof InviteReadQuerySchema>;
    const invite = await usableInvite(token, role);
    return reply.status(200).send({
      email: invite.email,
      expires_at: invite.expiresAt.toISOString(),
      org: { id: invite.org.id, name: invite.org.name },
    });
  };
}

/**
 * Verifies the caller's token; the BFF calls the invite routes with a service-account token.
 *
 * @throws {HttpError} UNAUTHORIZED.
 */
export async function authenticateCaller(req: FastifyRequest): Promise<void> {
  const auth = await authenticateAny(req);
  if (!auth.ok) {
    throw httpError('UNAUTHORIZED', {
      detail: auth.error.message,
      fields: { reason: auth.error.code },
    });
  }
  await recordRouteCaller(req, callerFromAny(auth.context));
}
