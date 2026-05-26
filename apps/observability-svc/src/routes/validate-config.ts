/**
 * GET /validate-config — admin endpoint to inspect the live runtime config.
 *
 * Returns a sanitised subset of the parsed AppConfig so operators can verify
 * that the Helm chart values were decoded correctly without exposing secrets.
 * Requires a valid Bearer token matching `ADMIN_TOKEN`. Token comparison is
 * performed in constant time to prevent timing-based token discovery.
 *
 * @module observability-svc/routes/validate-config
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';

/**
 * Compares two strings in constant time to prevent timing side-channel attacks.
 *
 * Returns false immediately when lengths differ (leaking length is acceptable
 * since token length is deterministic from config), then delegates to
 * `crypto.timingSafeEqual` for the byte comparison.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` when both strings are identical, `false` otherwise.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Registers the `/validate-config` admin route on the given Fastify instance.
 *
 * Returns `401` when the bearer token is absent or does not match `adminToken`.
 * Returns `200` with a sanitised config subset for authorised callers.
 *
 * @param app - The Fastify application instance to register the route on.
 * @param deps - Route dependencies: the admin token and the parsed config.
 */
export function registerValidateConfig(
  app: FastifyInstance,
  deps: { adminToken: string; config: AppConfig },
): void {
  app.get('/validate-config', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!constantTimeEqual(token, deps.adminToken)) {
      return reply.code(401).send();
    }
    return reply.send({
      outcome_metrics: deps.config.OUTCOME_METRICS,
      idem_ttl_days: deps.config.IDEM_TTL_DAYS,
    });
  });
}
