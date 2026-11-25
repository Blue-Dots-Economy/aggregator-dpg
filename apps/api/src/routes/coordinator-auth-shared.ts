/**
 * Coordinator sign-in check shared by the coordinator routes in `@aggregator-dpg/api`.
 *
 * The bulk upload, registration link and onboarding routes accept only an
 * approved coordinator's token and refuse every other caller in the same way.
 */

import type { FastifyRequest } from 'fastify';
import { httpError } from '../errors/http-error.js';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { throwIfActingError } from '../services/auth/acting.js';
import { callerFromAuth, recordRouteCaller } from '../services/authz/index.js';

/**
 * Verifies the request comes from an approved coordinator and records its login for RBAC.
 *
 * @param req - The incoming request.
 * @returns The verified coordinator's auth context.
 * @throws NOT_APPROVED if the coordinator is not approved.
 * @throws UNAUTHORIZED if the token is missing, invalid or carries no user id.
 * @throws The acting-mode error when an acting account is refused.
 */
export async function requireCoordinatorAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    throwIfActingError(result.error);
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.userId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing user_id claim.' });
  }
  await recordRouteCaller(req, callerFromAuth(result.context));
  return result.context;
}
