/**
 * Maintenance endpoints for the aggregator registration lifecycle.
 *
 * `@aggregator-dpg/api`. Houses the stale-pending-registration cleanup that
 * frees the email/phone namespace (Postgres row + Keycloak user) once an
 * approval link is well past its TTL and was never acted on. Invoked by an
 * out-of-band scheduler (cron/worker) using a service-account Bearer token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const CleanupResponseSchema = z
  .object({ scanned: z.number(), pruned: z.number(), prunedIds: z.array(z.string()) })
  .passthrough();

/**
 * Registers the stale-pending cleanup route. The cutoff is
 * `now - (APPROVAL_TOKEN_TTL_SECONDS*1000 + REGISTRATION_PENDING_GRACE_MS)`;
 * any `pending` registration last touched before the cutoff is deleted along
 * with its disabled Keycloak user.
 *
 * @param app - Fastify instance to attach the route to.
 */
export async function registerAggregatorMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/v1/aggregator-registrations/cleanup-stale',
    {
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Prune registrations stuck pending past token expiry + grace',
        response: { 200: CleanupResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.cleanup-stale' });
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', { detail: auth.error.message });
      }

      const store = getAggregatorStore();
      const idp = getIdpAdmin();
      const cutoffMs =
        Date.now() -
        (config.APPROVAL_TOKEN_TTL_SECONDS * 1000 + config.REGISTRATION_PENDING_GRACE_MS);
      const cutoff = new Date(cutoffMs);

      const page = await store.list({ status: 'pending', limit: 1000, offset: 0 });
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'aggregatorStore.list' },
        });
      }

      const stale = page.value.rows.filter((r) => r.updatedAt < cutoff);
      const prunedIds: string[] = [];
      for (const row of stale) {
        // Delete the KC user first so a partial failure leaves the DB row
        // (re-tried next pass) rather than an orphaned KC user.
        const kc = await idp.findByEmail(row.contactEmail);
        if (kc.ok && kc.value) {
          const del = await idp.deleteUser(kc.value.id);
          if (!del.ok) {
            log.warn(
              { status: 'skipped', aggregator_id: row.id, code: del.error.code },
              'skipped stale-pending prune — KC user delete failed',
            );
            continue;
          }
        }
        const deleted = await store.deleteById(row.id);
        if (!deleted.ok) {
          log.warn(
            { status: 'skipped', aggregator_id: row.id, code: deleted.error.code },
            'skipped stale-pending prune — DB delete failed',
          );
          continue;
        }
        prunedIds.push(row.id);
      }

      log.info(
        { status: 'success', scanned: page.value.rows.length, pruned: prunedIds.length },
        'stale-pending cleanup complete',
      );
      return reply
        .status(200)
        .send({ scanned: page.value.rows.length, pruned: prunedIds.length, prunedIds });
    },
  );
}
