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
import { config, orgHierarchyEnabled } from '../config.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const CleanupResponseSchema = z
  .object({
    scanned: z.number(),
    pruned: z.number(),
    prunedIds: z.array(z.string()),
    orgsScanned: z.number(),
    orgsPruned: z.number(),
    orgsPrunedIds: z.array(z.string()),
  })
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

      if (page.value.rows.length === 1000) {
        log.warn(
          { scanned: 1000 },
          'stale-pending cleanup hit the 1000-row cap — more stale rows may remain for the next pass',
        );
      }

      const stale = page.value.rows.filter((r) => r.updatedAt < cutoff);
      const prunedIds: string[] = [];
      for (const row of stale) {
        // Delete the KC user first so a partial failure leaves the DB row
        // (re-tried next pass) rather than an orphaned KC user.
        const kcStart = Date.now();
        const kc = await idp.findByEmail(row.contactEmail);
        if (!kc.ok) {
          log.warn(
            {
              status: 'skipped',
              aggregator_id: row.id,
              code: kc.error.code,
              latency_ms: Date.now() - kcStart,
            },
            'skipped stale-pending prune — KC user lookup failed',
          );
          continue;
        }
        if (kc.value) {
          const delStart = Date.now();
          const del = await idp.deleteUser(kc.value.id);
          if (!del.ok) {
            log.warn(
              {
                status: 'skipped',
                aggregator_id: row.id,
                code: del.error.code,
                latency_ms: Date.now() - delStart,
              },
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

      // Prune stale pending orgs too (§7). Same cutoff. Delete the mirrored KC
      // group + disabled owner user before the DB row so a partial failure
      // leaves the row for the next pass rather than orphaning KC objects.
      // Only runs when the hierarchy is on (the table is empty otherwise).
      const orgStore = getAggregatorOrgStore();
      let orgsScanned = 0;
      const orgsPrunedIds: string[] = [];
      if (orgHierarchyEnabled()) {
        const orgPage = await orgStore.listPending();
        if (!orgPage.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(orgPage.error.message),
            fields: { sub_operation: 'orgStore.listPending' },
          });
        }
        orgsScanned = orgPage.value.length;
        const staleOrgs = orgPage.value.filter((o) => o.updatedAt < cutoff);
        for (const org of staleOrgs) {
          const kc = await idp.findByEmail(org.ownerEmail);
          if (!kc.ok) {
            log.warn(
              { status: 'skipped', org_id: org.id, code: kc.error.code },
              'skipped stale-org prune — KC owner lookup failed',
            );
            continue;
          }
          if (kc.value) {
            const del = await idp.deleteUser(kc.value.id);
            if (!del.ok) {
              log.warn(
                { status: 'skipped', org_id: org.id, code: del.error.code },
                'skipped stale-org prune — KC owner delete failed',
              );
              continue;
            }
          }
          if (org.kcGroupId) {
            const delGroup = await idp.deleteGroup(org.kcGroupId);
            if (!delGroup.ok) {
              log.warn(
                { status: 'skipped', org_id: org.id, code: delGroup.error.code },
                'skipped stale-org prune — KC group delete failed',
              );
              continue;
            }
          }
          const deletedOrg = await orgStore.deleteById(org.id);
          if (!deletedOrg.ok) {
            log.warn(
              { status: 'skipped', org_id: org.id, code: deletedOrg.error.code },
              'skipped stale-org prune — DB delete failed',
            );
            continue;
          }
          orgsPrunedIds.push(org.id);
        }
      }

      log.info(
        {
          status: 'success',
          scanned: page.value.rows.length,
          pruned: prunedIds.length,
          orgsScanned,
          orgsPruned: orgsPrunedIds.length,
        },
        'stale-pending cleanup complete',
      );
      return reply.status(200).send({
        scanned: page.value.rows.length,
        pruned: prunedIds.length,
        prunedIds,
        orgsScanned,
        orgsPruned: orgsPrunedIds.length,
        orgsPrunedIds,
      });
    },
  );
}
