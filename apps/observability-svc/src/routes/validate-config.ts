/**
 * GET /validate-config — admin endpoint to inspect the live runtime config.
 *
 * Returns a sanitised subset of the parsed AppConfig so operators can verify
 * that the Helm chart values were decoded correctly without exposing secrets.
 * Requires a valid Bearer token matching `ADMIN_TOKEN`.
 *
 * @module observability-svc/routes/validate-config
 * @package @aggregator-dpg/observability-svc
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/** Dependencies required by the validate-config route. */
interface Deps {
  /** Expected value of the `Authorization: Bearer <token>` header. */
  adminToken: string;
  /** Full parsed runtime config to expose in the response. */
  config: AppConfig;
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
export function registerValidateConfig(app: FastifyInstance, deps: Deps): void {
  app.get('/validate-config', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token !== deps.adminToken) {
      return reply.code(401).send();
    }
    return reply.send({
      outcome_metrics: deps.config.OUTCOME_METRICS,
      idem_ttl_days: deps.config.IDEM_TTL_DAYS,
    });
  });
}
