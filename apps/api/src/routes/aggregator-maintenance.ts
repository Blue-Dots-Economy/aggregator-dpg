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
import { config } from '../config.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpAdminAdapter } from '../services/idp-admin/index.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

/** Minimal Result shape the prune helper needs from an idp delete. */
type DeleteResult = { ok: true } | { ok: false; error: { code: string } };
/** Minimal Result shape for resolving the KC user (id or null) to delete. */
type UserLookupResult =
  { ok: true; value: { id: string } | null } | { ok: false; error: { code: string } };
/** Minimal Result shape of a store's `deleteIfPending`. */
type DeleteIfPendingResult =
  | { ok: true; value: 'deleted' | 'not_pending' | 'aborted' }
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
  /** Row id (for logs). */
  idOf: (row: T) => string;
  /** Optional KC cleanup after the user delete (e.g. the org's mirrored group). */
  afterUserDelete?: (row: T) => Promise<DeleteResult> | null;
  /**
   * Deletes the row only while it is still pending and stale, running
   * `beforeCommit` (the Keycloak clean-up) with the row locked.
   */
  deleteIfPending: (row: T, beforeCommit: () => Promise<boolean>) => Promise<DeleteIfPendingResult>;
  /** Log id field name (`aggregator_id` | `org_id`). */
  logIdField: 'aggregator_id' | 'org_id';
  /** Log message kind (`stale-pending` | `stale-org`). */
  kind: string;
}

/**
 * Deletes each stale row together with its KC user (+ any extra KC objects),
 * skipping (with a warning) any row whose KC/DB call fails so the next pass
 * retries it rather than orphaning objects. Shared by the coordinator and org
 * cleanup loops.
 *
 * Race-safe against a concurrent decision (design C3): the row is deleted
 * first, inside a transaction, with a pending + stale predicate; the Keycloak
 * delete runs while that transaction holds the row, and a Keycloak failure
 * rolls the row back. A decision that lands first leaves nothing to prune
 * (`not_pending`); one that lands during the prune waits and finds the row gone.
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

    // Resolved from the stored linkage (not email) so drift/shared-email
    // can't hit the wrong user.
    const kc = await spec.resolveUser(row);
    if (!kc.ok) {
      warn(kc.error.code, 'KC user lookup failed');
      continue;
    }

    const deleted = await spec.deleteIfPending(row, async () => {
      if (kc.value) {
        const del = await idp.deleteUser(kc.value.id);
        if (!del.ok) {
          warn(del.error.code, 'KC user delete failed');
          return false;
        }
      }
      const extra = spec.afterUserDelete?.(row);
      if (extra) {
        const extraRes = await extra;
        if (!extraRes.ok) {
          warn(extraRes.error.code, 'KC group delete failed');
          return false;
        }
      }
      return true;
    });
    if (!deleted.ok) {
      warn(deleted.error.code, 'DB delete failed');
      continue;
    }
    if (deleted.value === 'not_pending') {
      log.info(
        { status: 'skipped', [spec.logIdField]: id },
        `skipped ${spec.kind} prune — decided or touched meanwhile`,
      );
      continue;
    }
    if (deleted.value === 'deleted') prunedIds.push(id);
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
          deleteIfPending: (r, beforeCommit) => store.deleteIfPending(r.id, cutoff, beforeCommit),
          logIdField: 'aggregator_id',
          kind: 'stale-pending',
        },
        idp,
        log,
      );

      // Prune stale pending orgs too (§7). Same cutoff + row/KC-user/DB-row
      // sequence, plus the mirrored KC group. The store only lists aggregator
      // orgs, and the root and Default orgs are never pending.
      const orgStore = getAggregatorOrgStore();
      let orgsScanned = 0;
      let orgsPrunedIds: string[] = [];
      {
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
            // Key the KC owner user on the owner's recorded login, not email.
            // An owner who also owns another org keeps their KC user (and
            // role); only this org's group and row go (0027, F11).
            resolveUser: async (o) => {
              if (!o.ownerKcSub) return { ok: true as const, value: null };
              const shared = await orgStore.ownerIsShared(o.id);
              if (!shared.ok) {
                return {
                  ok: false as const,
                  error: { code: 'IDP_UNAVAILABLE' as const, message: shared.error.message },
                };
              }
              if (shared.value) return { ok: true as const, value: null };
              return idp.findById(o.ownerKcSub);
            },
            idOf: (o) => o.id,
            afterUserDelete: (o) => (o.kcGroupId ? idp.deleteGroup(o.kcGroupId) : null),
            deleteIfPending: (o, beforeCommit) =>
              orgStore.deleteIfPending(o.id, cutoff, beforeCommit),
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
