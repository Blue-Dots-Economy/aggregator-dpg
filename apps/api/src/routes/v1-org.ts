/**
 * Console organisation routes `/v1/org/*` of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET   /v1/org/read/:id              one org within reach, owner and counts
 *   POST  /v1/org/search                orgs within reach (or below one), by name, keyset paged
 *   PATCH /v1/org/metadata/update/:id   org details (name, known_as, parent: network admin only)
 *   POST  /v1/org/decision/:id          approve / reject a pending org (network admin)
 *   POST  /v1/org/access/repair/:id     re-apply the owner's sign-in access (network admin)
 *   GET   /v1/org/hierarchy             the configured levels and their org counts (network admin)
 *
 * Every handler calls `requireActor` first (admins only). A target out of
 * reach answers 404; a route the actor's kind cannot use answers 403. The
 * Default org's details are never editable. Only the network admin can read
 * the root, and search never returns it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DecisionRequestSchema,
  OrgDecisionResponseSchema,
  OrgHierarchyResponseSchema,
  OrgMetadataUpdateRequestSchema,
  OrgReadResponseSchema,
  OrgSchema,
  OrgSearchRequestSchema,
  OrgSearchResponseSchema,
  OwnerAccessResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import type { KnownAsConfig } from '@aggregator-dpg/network-config/interface';
import { levelOf, levelsOf } from '../services/known-as.js';
import {
  getOrganisationStore,
  type Organisation,
  type UpdateOrgPatch,
} from '../services/organisation-store/index.js';
import { isNetworkAdmin, requireActor, type Actor } from '../services/auth/actor/index.js';
import { reachesOrg } from '../services/authz/scope.js';
import { isOnlyViewed, viewableOrgIds } from '../services/authz/view-scope.js';
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
  org: Organisation;
  orgType: 'network_facilitator' | 'aggregator';
}

/** The org ids an actor may read: its reach and every org below (owners only). */
async function viewable(actor: Actor): Promise<string[] | null> {
  const ids = await viewableOrgIds(actor);
  if (!ids.ok) dbDown('orgStore.descendantIds', ids.error.message);
  return ids.value;
}

/**
 * Loads an org within the actor's reach (the root for the network admin
 * only), else 404. With `view`, an owner also reaches every org below its own.
 *
 * @throws {HttpError} NOT_FOUND / DB_UNAVAILABLE.
 */
async function orgInReach(
  actor: Actor,
  id: string,
  purpose: 'manage' | 'view' = 'manage',
): Promise<FoundOrg> {
  const store = getOrganisationStore();
  const found = await store.findById(id);
  if (!found.ok) dbDown('orgStore.findById', found.error.message);
  if (found.value) {
    let inReach = reachesOrg(actor, found.value.id);
    if (purpose === 'view') {
      const ids = await viewable(actor);
      inReach = ids === null || ids.includes(found.value.id);
    }
    if (!inReach) throw httpError('NOT_FOUND');
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
  known_as: 'the "known as" label',
  parent_id: 'the parent organisation',
};

/** The instance's "known as" list, from the network config. */
async function knownAsConfig(): Promise<KnownAsConfig> {
  return (await getNetworkConfig()).aggregator.organisation.known_as;
}

/** Refuses a placement with 400, naming the field. */
function badPlacement(field: 'known_as' | 'parent_id', reason: string, detail: string): never {
  throw httpError('SCHEMA_VALIDATION', { detail, fields: { [field]: reason } });
}

/**
 * Checks a change of an org's "known as" value or parent.
 *
 * A level-N value needs a parent at level N-1 (the network for level 1): an
 * active org other than the Default org and the org itself. A change of level
 * needs `parent_id`. An org with child orgs cannot change either, so the
 * levels below it never break and no cycle can form.
 *
 * @param org - The org being edited.
 * @param body - The requested `known_as` and `parent_id`.
 * @param cfg - The instance's "known as" config.
 * @returns The store patch fields for the change; empty when nothing changes.
 * @throws {HttpError} SCHEMA_VALIDATION, CONFLICT or DB_UNAVAILABLE.
 */
async function checkPlacement(
  org: Organisation,
  body: { known_as?: string | undefined; parent_id?: string | undefined },
  cfg: KnownAsConfig,
): Promise<Pick<UpdateOrgPatch, 'knownAs' | 'parentId'>> {
  const valid = cfg.values.map((v) => v.key).join(', ');
  if (body.known_as !== undefined && levelOf(cfg, body.known_as) === null) {
    badPlacement('known_as', 'invalid', `unknown known_as '${body.known_as}'; valid: ${valid}`);
  }
  const keyChanges = body.known_as !== undefined && body.known_as !== org.knownAs;
  const parentChanges = body.parent_id !== undefined && body.parent_id !== org.parentId;
  if (!keyChanges && !parentChanges) return {};

  const store = getOrganisationStore();
  const kids = await store.hasChildren(org.id);
  if (!kids.ok) dbDown('orgStore.hasChildren', kids.error.message);
  if (kids.value) {
    throw httpError('CONFLICT', {
      detail: 'Move the organisations under this one first.',
      fields: { reason: 'has_children' },
    });
  }

  const key = body.known_as ?? org.knownAs;
  const level = levelOf(cfg, key);
  if (level === null) {
    badPlacement('known_as', 'required', `Set known_as to one of: ${valid}.`);
  }
  if (keyChanges && level !== levelOf(cfg, org.knownAs) && body.parent_id === undefined) {
    badPlacement(
      'parent_id',
      'required',
      `A Level ${level} value needs a parent at Level ${level - 1}.`,
    );
  }
  const parentId = body.parent_id ?? org.parentId;
  if (!parentId) {
    badPlacement('parent_id', 'required', `A Level ${level} value needs a parent.`);
  }
  if (parentId === org.id) {
    badPlacement('parent_id', 'invalid', 'An organisation cannot be its own parent.');
  }
  const wrongParent = () =>
    badPlacement(
      'parent_id',
      'invalid',
      level === 1
        ? 'A Level 1 organisation sits directly under the network.'
        : `The parent must be an active Level ${level - 1} organisation.`,
    );
  if (level === 1) {
    const root = await store.findRoot();
    if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
    if (root.value?.id !== parentId) wrongParent();
  } else {
    const parent = await store.findById(parentId);
    if (!parent.ok) dbDown('orgStore.findById', parent.error.message);
    const p = parent.value;
    if (!p || p.status !== 'active' || p.isDefault || levelOf(cfg, p.knownAs) !== level - 1) {
      wrongParent();
    }
  }
  return {
    ...(keyChanges ? { knownAs: key } : {}),
    ...(parentId !== org.parentId ? { parentId } : {}),
  };
}

/**
 * Reads the hierarchy response: the root and each configured level with its
 * values and their pending and active org counts.
 *
 * @throws {HttpError} DB_UNAVAILABLE when the root or the counts cannot be read.
 */
async function readHierarchy() {
  const store = getOrganisationStore();
  const [root, counts] = await Promise.all([store.findRoot(), store.countByKnownAs()]);
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  if (!root.value) dbDown('orgStore.findRoot', 'network root missing');
  if (!counts.ok) dbDown('orgStore.countByKnownAs', counts.error.message);
  return {
    network: { id: root.value.id, name: root.value.displayName },
    levels: levelsOf(await knownAsConfig()).map((l) => ({
      level: l.level,
      values: l.values.map((v) => ({ ...v, org_count: counts.value[v.key] ?? 0 })),
    })),
  };
}

/**
 * Registers the `/v1/org/*` console routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1OrgRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/org/read/:id',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: 'One organisation within reach, with its owner and coordinator counts',
        description:
          'An owner also reads, read-only, every organisation below its own; the owner contact of such an organisation is masked.',
        params: IdParamsSchema,
        response: { 200: OrgReadResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const { org, orgType } = await orgInReach(actor, id, 'view');
      const below = orgType === 'aggregator' && isOnlyViewed(actor, org.id);
      const counts = await getUserStore().countByOrg([org.id]);
      if (!counts.ok) dbDown('userStore.countByOrg', counts.error.message);
      const c = counts.value[org.id];
      req.log.info({
        operation: 'console.org.read',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        relation: below ? 'below' : 'own',
      });
      return reply.status(200).send({
        org: toWireOrg(org, await knownAsConfig(), orgType),
        // An org only viewed from above shows its owner's contact masked.
        owner: { id: org.ownerUserId, contact: ownerContact(org, { masked: below }) },
        coordinator_count: c?.total ?? 0,
        pending_count: c?.pending ?? 0,
      });
    },
  );

  app.post(
    '/v1/org/search',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: 'Organisations within reach, by name',
        description:
          'The network admin sees every aggregator organisation; an owner sees the ones it owns and, read-only, every one below them. With `descendants_of` set to an org within reach, lists every org below it instead (read-only). Filters by status, a case-insensitive name prefix and the "known as" key; keyset paged by an opaque cursor.',
        body: OrgSearchRequestSchema,
        response: { 200: OrgSearchResponseSchema, ...errorResponses(400, 401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const body = req.body as z.infer<typeof OrgSearchRequestSchema>;
      const below = body.filter.descendants_of;
      // An owner reads its own orgs and every org below them. Below an org out
      // of that reach: an empty page, as for any out-of-reach filter.
      const view = await viewable(actor);
      let orgIds = view;
      if (below !== undefined) orgIds = view === null || view.includes(below) ? null : [];
      const knownAs = await knownAsConfig();
      const page = await getOrganisationStore().search({
        orgIds,
        ...(below ? { descendantsOf: below } : {}),
        ...(body.filter.status ? { status: body.filter.status } : {}),
        ...(body.filter.name_prefix ? { namePrefix: body.filter.name_prefix } : {}),
        ...(body.filter.known_as ? { knownAs: body.filter.known_as } : {}),
        ...(body.cursor ? { cursor: decodeOrgCursor(body.cursor) } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });
      if (!page.ok) dbDown('orgStore.search', page.error.message);
      const ids = page.value.rows.map((o) => o.id);
      const counts = await getUserStore().countByOrg(ids);
      if (!counts.ok) dbDown('userStore.countByOrg', counts.error.message);
      return reply.status(200).send({
        orgs: page.value.rows.map((o) => ({
          ...toWireOrg(o, knownAs),
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
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary: "Update an organisation's details",
        description:
          "url, locations, legal name and GST number: the owner or the network admin. The name, known_as and parent_id: the network admin only (the slug never changes). known_as must be a configured value; a value at level N needs a parent at level N-1 (the network for level 1), so a change of level must send parent_id. An org with child orgs cannot change known_as or parent (409). The Default org's details are not editable. Rendered for every coordinator of the org at once.",
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
      const adminOnly = [body.name, body.known_as, body.parent_id].some((v) => v !== undefined);
      if (adminOnly && !isNetworkAdmin(actor)) throw httpError('FORBIDDEN');
      const knownAs = await knownAsConfig();
      const placement = await checkPlacement(org, body, knownAs);
      await guardWriteRate(actor, reply);

      const patch: UpdateOrgPatch = { updatedBy: actor.userId };
      if (body.name !== undefined) patch.displayName = body.name;
      if (body.url !== undefined) patch.url = body.url;
      if (body.locations !== undefined) patch.locations = body.locations;
      if (body.legal_name !== undefined) patch.legalName = body.legal_name;
      if (body.gst_number !== undefined) patch.gstNumber = body.gst_number;
      Object.assign(patch, placement);

      const updated = await getOrganisationStore().update(org.id, patch);
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
      return reply.status(200).send(toWireOrg(updated.value, knownAs));
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

  app.get(
    '/v1/org/hierarchy',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'The configured organisation levels and their org counts (network admin)',
        description:
          'Read-only. Level 1 sits directly under the network. Each level lists its "known as" values from the instance config, with how many pending and active organisations carry each.',
        response: { 200: OrgHierarchyResponseSchema, ...errorResponses(401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      return reply.status(200).send(await readHierarchy());
    },
  );
}
