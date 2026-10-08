/**
 * Console organisation routes `/v1/org/*` (`@aggregator-dpg/api`, user & org
 * Phase 5).
 *
 *   GET   /v1/org/read/:id              one org within reach, owner and counts
 *   POST  /v1/org/search                orgs within reach, by name, keyset paged
 *   PATCH /v1/org/metadata/update/:id   org details (name: network admin only)
 *   POST  /v1/org/decision/:id          approve / reject a pending org (network admin)
 *   POST  /v1/org/access/repair/:id     re-apply the owner's sign-in access (network admin)
 *
 * Every handler calls `requireActor` first (admins only). A target out of
 * reach answers 404; a route the actor's kind cannot use answers 403. The
 * Default org's details are never editable (design R8). The root is read by
 * the network admin only and is not part of a search.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DecisionRequestSchema,
  OrgDecisionResponseSchema,
  OrgMetadataUpdateRequestSchema,
  OrgReadResponseSchema,
  OrgSchema,
  OrgSearchRequestSchema,
  OrgSearchResponseSchema,
  OwnerAccessResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import {
  getAggregatorOrgStore,
  type AggregatorOrg,
  type UpdateOrgPatch,
} from '../services/aggregator-org-store/index.js';
import { isNetworkAdmin, requireActor, type Actor } from '../services/auth/actor/index.js';
import { reachableOrgIds, reachesOrg } from '../services/authz/scope.js';
import { decideOrg, grantOwnerAccess } from '../services/decisions/org.js';
import {
  decodeOrgCursor,
  encodeOrgCursor,
  guardWriteRate,
  listPhrase,
  notifyOwnerOfAdminAction,
  ownerContact,
  toWireOrg,
} from './console-shared.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
type IdParams = z.infer<typeof IdParamsSchema>;

/** Throws `DB_UNAVAILABLE` naming the failed store call. */
function dbDown(subOperation: string, message: string): never {
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(message),
    fields: { sub_operation: subOperation },
  });
}

/** An org found for the actor, with its type. */
interface FoundOrg {
  org: AggregatorOrg;
  orgType: 'network_facilitator' | 'aggregator';
}

/**
 * Loads an org within the actor's reach (the root for the network admin
 * only), else 404.
 *
 * @throws {HttpError} NOT_FOUND / DB_UNAVAILABLE.
 */
async function orgInReach(actor: Actor, id: string): Promise<FoundOrg> {
  const store = getAggregatorOrgStore();
  const found = await store.findById(id);
  if (!found.ok) dbDown('orgStore.findById', found.error.message);
  if (found.value) {
    if (!reachesOrg(actor, found.value.id)) throw httpError('NOT_FOUND');
    return { org: found.value, orgType: 'aggregator' };
  }
  if (isNetworkAdmin(actor)) {
    const root = await store.findRoot();
    if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
    if (root.value?.id === id) return { org: root.value, orgType: 'network_facilitator' };
  }
  throw httpError('NOT_FOUND');
}

/** Refuses a non-network-admin with 403 (a route its kind cannot use). */
function requireNetworkAdmin(actor: Actor): void {
  if (!isNetworkAdmin(actor)) throw httpError('FORBIDDEN');
}

/** Wire field label of each editable org detail, for logs and owner notices. */
const FIELD_LABELS: Record<string, string> = {
  name: 'the name',
  url: 'the website',
  locations: 'the locations',
  legal_name: 'the legal name',
  gst_number: 'the GST number',
};

/**
 * Registers the `/v1/org/*` console routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1OrgRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/org/read/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'One organisation within reach, with its owner and coordinator counts',
        params: IdParamsSchema,
        response: { 200: OrgReadResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const { org, orgType } = await orgInReach(actor, id);
      const counts = await getAggregatorStore().countByOrg([org.id]);
      if (!counts.ok) dbDown('aggregatorStore.countByOrg', counts.error.message);
      const c = counts.value[org.id];
      req.log.info({
        operation: 'console.org.read',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
      });
      return reply.status(200).send({
        org: toWireOrg(org, orgType),
        owner: { id: org.ownerUserId, contact: ownerContact(org) },
        coordinator_count: c?.total ?? 0,
        pending_count: c?.pending ?? 0,
      });
    },
  );

  app.post(
    '/v1/org/search',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Organisations within reach, by name',
        description:
          'The network admin sees every aggregator organisation; an owner sees the ones it owns. Filters by status and a case-insensitive name prefix; keyset paged by an opaque cursor.',
        body: OrgSearchRequestSchema,
        response: { 200: OrgSearchResponseSchema, ...errorResponses(400, 401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const body = req.body as z.infer<typeof OrgSearchRequestSchema>;
      const page = await getAggregatorOrgStore().search({
        orgIds: reachableOrgIds(actor),
        ...(body.filter.status ? { status: body.filter.status } : {}),
        ...(body.filter.name_prefix ? { namePrefix: body.filter.name_prefix } : {}),
        ...(body.cursor ? { cursor: decodeOrgCursor(body.cursor) } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });
      if (!page.ok) dbDown('orgStore.search', page.error.message);
      const ids = page.value.rows.map((o) => o.id);
      const counts = await getAggregatorStore().countByOrg(ids);
      if (!counts.ok) dbDown('aggregatorStore.countByOrg', counts.error.message);
      return reply.status(200).send({
        orgs: page.value.rows.map((o) => ({
          ...toWireOrg(o),
          coordinator_count: counts.value[o.id]?.total ?? 0,
          pending_count: counts.value[o.id]?.pending ?? 0,
        })),
        next_cursor: page.value.nextCursor ? encodeOrgCursor(page.value.nextCursor) : null,
      });
    },
  );

  app.patch(
    '/v1/org/metadata/update/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: "Update an organisation's details",
        description:
          "url, locations, legal name and GST number: the owner or the network admin. The name: the network admin only (the slug never changes). The Default org's details are not editable. Rendered for every coordinator of the org at once.",
        params: IdParamsSchema,
        body: OrgMetadataUpdateRequestSchema,
        response: { 200: OrgSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgMetadataUpdateRequestSchema>;
      const { org, orgType } = await orgInReach(actor, id);
      if (orgType !== 'aggregator' || org.isDefault) {
        throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
      }
      if (body.name !== undefined && !isNetworkAdmin(actor)) throw httpError('FORBIDDEN');
      await guardWriteRate(actor, reply);

      const patch: UpdateOrgPatch = { updatedBy: actor.userId };
      if (body.name !== undefined) patch.displayName = body.name;
      if (body.url !== undefined) patch.url = body.url;
      if (body.locations !== undefined) patch.locations = body.locations;
      if (body.legal_name !== undefined) patch.legalName = body.legal_name;
      if (body.gst_number !== undefined) patch.gstNumber = body.gst_number;

      const updated = await getAggregatorOrgStore().update(org.id, patch);
      if (!updated.ok) {
        if (updated.error.code === 'DUPLICATE_NAME') throw httpError('ORG_NAME_TAKEN');
        if (updated.error.code === 'NOT_FOUND') throw httpError('NOT_FOUND');
        dbDown('orgStore.update', updated.error.message);
      }
      const fields = Object.keys(body);
      req.log.info({
        operation: 'console.org.update',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        fields,
      });
      await notifyOwnerOfAdminAction(
        actor,
        updated.value,
        `updated ${listPhrase(fields.map((f) => FIELD_LABELS[f] ?? f))}`,
        req.log,
      );
      return reply.status(200).send(toWireOrg(updated.value));
    },
  );

  app.post(
    '/v1/org/decision/:id',
    {
      config: { rbac: { capability: 'orgs.onboard' } },
      schema: {
        tags: ['console'],
        summary: 'Approve or reject a pending organisation (network admin)',
        description:
          "The same compare-and-set service as the emailed review link. Approval enables the owner's sign-in (owner_access reports how far it got; repair re-runs it).",
        params: IdParamsSchema,
        body: DecisionRequestSchema,
        response: {
          200: OrgDecisionResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof DecisionRequestSchema>;
      await guardWriteRate(actor, reply);

      const outcome = await decideOrg({
        orgId: id,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
        decidedBy: actor.userId,
        log: req.log.child({ actor_id: actor.userId }),
      });
      switch (outcome.kind) {
        case 'decided':
          return reply.status(200).send({
            id,
            status: outcome.decision === 'approve' ? 'active' : 'inactive',
            notified: outcome.notified,
            owner_access: outcome.decision === 'approve' ? outcome.ownerAccess.status : 'none',
          });
        case 'already_decided':
          throw httpError('ALREADY_DECIDED', {
            fields: {
              status: outcome.status,
              decided_at: outcome.decidedAt.toISOString(),
              decided_by: outcome.decidedBy,
            },
          });
        case 'not_found':
          throw httpError('NOT_FOUND');
        case 'unavailable':
          throw httpError('DB_UNAVAILABLE');
      }
    },
  );

  app.post(
    '/v1/org/access/repair/:id',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: "Re-apply an active organisation's owner sign-in access (network admin)",
        description:
          "Enables the owner's Keycloak user, grants the org_owner role and adds them to the org's group. Idempotent.",
        params: IdParamsSchema,
        response: {
          200: OwnerAccessResponseSchema,
          ...errorResponses(401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      const { org, orgType } = await orgInReach(actor, id);
      if (orgType !== 'aggregator' || org.status !== 'active') {
        throw httpError('CONFLICT', { detail: 'Only an active organisation has owner access.' });
      }
      await guardWriteRate(actor, reply);
      const log = req.log.child({
        operation: 'console.org.repairAccess',
        actor_id: actor.userId,
        target_id: org.id,
      });
      const result = await grantOwnerAccess(org, log);
      log.info({ status: 'success', owner_access: result.status });
      return reply.status(200).send({ id: org.id, ...result });
    },
  );
}
