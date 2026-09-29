/**
 * Shared auth guards for the coordinator-facing route modules.
 *
 * Five route files carried byte-identical copies of one of two guards, and two
 * of them carried identical copies of the aggregator-type check. All of them
 * derive the aggregator identity from the **verified session token** and from
 * nothing else — no route reads `aggregator_id` from a body, query or header —
 * so holding one copy of each is what keeps that invariant auditable in a
 * single place.
 *
 * `dashboard.ts` and `campaign/auth.ts` keep their own variants on purpose:
 * the first promotes a missing `aggregator_id` claim to 403 and attaches a
 * `reason` field, the second adds the campaign-manager system-token rejection.
 * Neither is this shape.
 *
 * @module apps/api/src/routes/auth-shared
 */

import type { FastifyRequest } from 'fastify';
import { authenticate, requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';

/**
 * Approval-gated guard: the caller must present a verified token, be an
 * approved aggregator, and carry an `aggregator_id` claim.
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link AuthContext}. Its `aggregatorId` comes from the
 *   token claim — never from anything the client sent in the request.
 * @throws `NOT_APPROVED` when the aggregator is not approved yet;
 *   `UNAUTHORIZED` for every other failure, including a verified token with no
 *   `aggregator_id` claim.
 */
export async function requireApprovedAggregator(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}

/**
 * Plain authentication guard for routes that do not gate on approval.
 *
 * Promotes a missing `aggregator_id` claim to 403 (the credential is valid but
 * carries no tenant) and leaves every other failure at 401.
 *
 * @param req - The inbound request carrying the Bearer token.
 * @returns The verified {@link AuthContext}, aggregator identity taken from the
 *   token claim only.
 * @throws `FORBIDDEN` on `MISSING_AGGREGATOR_ID`, `UNAUTHORIZED` otherwise.
 */
export async function requireAuthenticatedAggregator(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}

/**
 * Reject when the requested type does not match the aggregator's registered
 * type (JWT `aggregator_type` claim). An aggregator may only upload, template
 * or create registration links for the type it registered as.
 *
 * @param auth - The verified auth context.
 * @param requestedType - The participant type / link domain the request asked
 *   for (`seeker` | `provider`).
 * @throws `AGGREGATOR_TYPE_MISSING` when the token carries no
 *   `aggregator_type`; `AGGREGATOR_TYPE_MISMATCH` when it does not match.
 */
export function enforceAggregatorType(auth: AuthContext, requestedType: string): void {
  if (!auth.aggregatorType) {
    throw httpError('AGGREGATOR_TYPE_MISSING', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  if (auth.aggregatorType !== requestedType) {
    throw httpError('AGGREGATOR_TYPE_MISMATCH', {
      fields: {
        aggregator_type: auth.aggregatorType,
        requested_type: requestedType,
      },
    });
  }
}
