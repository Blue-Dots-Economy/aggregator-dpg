/**
 * Checks shared by the public coordinator and organisation registration routes.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authenticateAny } from '../services/auth/access-token.js';
import { callerFromAny, recordRouteCaller } from '../services/authz/index.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { httpError } from '../errors/http-error.js';

/**
 * Refuses a request without a valid token, then records the caller.
 *
 * @throws {HttpError} UNAUTHORIZED
 */
export async function assertServiceCaller(req: FastifyRequest): Promise<void> {
  const auth = await authenticateAny(req);
  if (!auth.ok) {
    throw httpError('UNAUTHORIZED', {
      detail: auth.error.message,
      fields: { reason: auth.error.code },
    });
  }
  await recordRouteCaller(req, callerFromAny(auth.context));
}

/**
 * Submit rate limit per key. Fails open, so a Redis outage does not block registration.
 *
 * @throws {HttpError} RATE_LIMITED, with a Retry-After header.
 */
export async function assertSubmitRate(key: string, reply: FastifyReply): Promise<void> {
  const rl = await checkSubmitRate(key);
  if (!rl.allowed) {
    void reply.header('Retry-After', String(rl.retryAfterSeconds));
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${rl.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: rl.retryAfterSeconds },
    });
  }
}
