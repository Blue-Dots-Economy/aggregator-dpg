/**
 * Maintenance endpoints for the aggregator registration lifecycle.
 *
 * `@aggregator-dpg/api`. Houses the stale-pending-registration cleanup that
 * frees the email/phone namespace (Postgres row + Keycloak user) once an
 * approval link is well past its TTL and was never acted on. Invoked by an
 * out-of-band scheduler (cron/worker) using a service-account Bearer token.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, orgHierarchyEnabled } from '../config.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpAdminAdapter } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

/** Minimal Result shape the prune helper needs from a store/idp delete. */
type DeleteResult = { ok: true } | { ok: false; error: { code: string } };
/** Minimal Result shape for resolving the KC user (id or null) to delete. */
type UserLookupResult =
  | { ok: true; value: { id: string } | null }
  | { ok: false; error: { code: string } };

/** Describes one entity's stale-prune: how to read it + how to delete its parts. */
interface PruneSpec<T> {
  /** Stale rows to prune (already filtered by cutoff). */
  rows: T[];
  /**
   * Resolves the KC user to delete from the row's *stored* linkage (coordinator
   * `aggregator_id` attribute / org `ownerKcSub`) — not by email, which can
   * drift or be shared across the two tables and hit the wrong user.
   */
  resolveUser: (row: T) => Promise<UserLookupResult>;
  /** Row id (for logs + the DB delete). */
  idOf: (row: T) => string;
  /** Optional KC cleanup after the user delete (e.g. the org's mirrored group). */
  afterUserDelete?: (row: T) => Promise<DeleteResult> | null;
  /** Deletes the DB row. */
  deleteRow: (row: T) => Promise<DeleteResult>;
  /** Log id field name (`aggregator_id` | `org_id`). */
  logIdField: 'aggregator_id' | 'org_id';
  /** Log message kind (`stale-pending` | `stale-org`). */
  kind: string;
}

/**
 * Deletes each stale row's KC user (+ any extra KC objects) then its DB row,
 * skipping (with a warning) any row whose KC/DB call fails so the next pass
 * retries it rather than orphaning objects. Shared by the coordinator and org
 * cleanup loops.
 *
 * @returns The ids that were fully pruned.
 */
async function pruneStale<T>(
  spec: PruneSpec<T>,
  idp: IdpAdminAdapter,
  log: FastifyBaseLogger,
): Promise<string[]> {
  const prunedIds: string[] = [];
  for (const row of spec.rows) {
    const id = spec.idOf(row);
    const warn = (code: string, step: string): void =>
      log.warn(
        { status: 'skipped', [spec.logIdField]: id, code },
        `skipped ${spec.kind} prune — ${step}`,
      );

    // Delete the KC user first so a partial failure leaves the DB row for the
    // next pass rather than an orphaned KC user. Resolved from the stored
    // linkage (not email) so drift/shared-email can't hit the wrong user.
    const kc = await spec.resolveUser(row);
    if (!kc.ok) {
      warn(kc.error.code, 'KC user lookup failed');
      continue;
    }
    if (kc.value) {
      const del = await idp.deleteUser(kc.value.id);
      if (!del.ok) {
        warn(del.error.code, 'KC user delete failed');
        continue;
      }
    }

    const extra = spec.afterUserDelete?.(row);
    if (extra) {
      const extraRes = await extra;
      if (!extraRes.ok) {
        warn(extraRes.error.code, 'KC group delete failed');
        continue;
      }
    }

    const deleted = await spec.deleteRow(row);
    if (!deleted.ok) {
      warn(deleted.error.code, 'DB delete failed');
      continue;
    }
    prunedIds.push(id);
  }
  return prunedIds;
}

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
      // Destructive op — restrict to a service-account token (the scheduler),
      // not any authenticated end user. Keycloak service accounts have a
      // `service-account-<client>` subject; human tokens carry a UUID subject.
      if (!auth.context.subject.startsWith('service-account-')) {
        throw httpError('FORBIDDEN', {
          detail: 'cleanup-stale requires a service-account token',
          fields: { subject: auth.context.subject },
        });
      }

      const store = getAggregatorStore();
      const idp = getIdpAdmin();
      const cutoffMs =
        Date.now() -
        (config.APPROVAL_TOKEN_TTL_SECONDS * 1000 + config.REGISTRATION_PENDING_GRACE_MS);
      const cutoff = new Date(cutoffMs);

      // Filter by age in SQL so the row cap counts genuinely-stale rows (a page
      // of fresh pending rows can't mask real stale ones).
      const page = await store.list({
        status: 'pending',
        updatedBefore: cutoff,
        limit: 1000,
        offset: 0,
      });
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'aggregatorStore.list' },
        });
      }

      if (page.value.rows.length === 1000) {
        log.warn(
          { scanned: 1000 },
          'stale-pending cleanup hit the 1000-row cap — more stale rows remain for the next pass',
        );
      }

      const prunedIds = await pruneStale(
        {
          rows: page.value.rows,
          // Key the KC user on the stored `aggregator_id` attribute, not email.
          resolveUser: (r) => idp.findByAttribute(KC_ATTR.AGGREGATOR_ID, r.id),
          idOf: (r) => r.id,
          deleteRow: (r) => store.deleteById(r.id),
          logIdField: 'aggregator_id',
          kind: 'stale-pending',
        },
        idp,
        log,
      );

      // Prune stale pending orgs too (§7). Same cutoff + row/KC-user/DB-row
      // sequence, plus the mirrored KC group. Only runs when the hierarchy is
      // on (the table is empty otherwise).
      const orgStore = getAggregatorOrgStore();
      let orgsScanned = 0;
      let orgsPrunedIds: string[] = [];
      if (orgHierarchyEnabled()) {
        const orgPage = await orgStore.listPending(cutoff);
        if (!orgPage.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(orgPage.error.message),
            fields: { sub_operation: 'orgStore.listPending' },
          });
        }
        orgsScanned = orgPage.value.length;
        orgsPrunedIds = await pruneStale(
          {
            rows: orgPage.value,
            // Key the KC owner user on the stored `ownerKcSub`, not email.
            resolveUser: (o) =>
              o.ownerKcSub
                ? idp.findById(o.ownerKcSub)
                : Promise.resolve({ ok: true as const, value: null }),
            idOf: (o) => o.id,
            afterUserDelete: (o) => (o.kcGroupId ? idp.deleteGroup(o.kcGroupId) : null),
            deleteRow: (o) => orgStore.deleteById(o.id),
            logIdField: 'org_id',
            kind: 'stale-org',
          },
          idp,
          log,
        );
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
