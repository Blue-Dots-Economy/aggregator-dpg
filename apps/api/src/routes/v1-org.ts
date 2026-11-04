/**
 * Console organisation routes `/v1/org/*` of the aggregator API (`@aggregator-dpg/api`).
 *
 *   GET   /v1/org/read/:id              one org within reach, owner and counts
 *   POST  /v1/org/search                orgs within reach (or below one), by name, keyset paged
 *   PATCH /v1/org/metadata/update/:id   org details (owner only)
 *   PATCH /v1/org/known-as/update/:id   an org's "known as" value (the parent's owner), or the
 *                                       values it defines for its children (the org's owner)
 *   PATCH /v1/org/parent/update/:id     move an org and the orgs below it (network admin)
 *   GET   /v1/org/parent/options/:id    candidate parents for a move (network admin)
 *   POST  /v1/org/decision/:id          approve / reject a pending org (network admin)
 *   POST  /v1/org/access/repair/:id     re-apply the owner's sign-in access (network admin)
 *   GET   /v1/org/hierarchy             the network, its "known as" values and the tree limits (network admin)
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
  OrgKnownAsUpdateRequestSchema,
  OrgMetadataUpdateRequestSchema,
  OrgParentOptionsResponseSchema,
  OrgParentUpdateRequestSchema,
  OrgReadResponseSchema,
  OrgSchema,
  OrgSearchRequestSchema,
  OrgSearchResponseSchema,
  OwnerAccessResponseSchema,
  type KnownAsValues,
  type KnownAsValuesRequest,
  type KnownAsEntry,
  type OrgKnownAsUpdateRequest,
  type OrgHierarchyResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getUserStore } from '../services/user-store/index.js';
import { getNetworkConfig } from '../services/network-config.js';
import type { OrganisationConfig } from '@aggregator-dpg/network-config/interface';
import { knownAsChoices, treeRules } from '../services/known-as.js';
import {
  getOrganisationStore,
  type Organisation,
  type OrgStoreError,
  type UpdateOrgPatch,
} from '../services/organisation-store/index.js';
import {
  isNetworkAdmin,
  ownedOrgIds,
  requireActor,
  type Actor,
} from '../services/auth/actor/index.js';
import { reachesOrg } from '../services/authz/scope.js';
import { isOnlyViewed, viewableOrgIds } from '../services/authz/view-scope.js';
import { decideOrg, grantOwnerAccess } from '../services/decisions/org.js';
import { validateOrgUpdate } from '../services/org-schema-validator.js';
import {
  decodeOrgCursor,
  encodeOrgCursor,
  guardWriteRate,
  notifyOwnerOfAdminAction,
  notifyOwnerOfParentAction,
  ownerContact,
  throwTreeRefusal,
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
    if (!inReach && purpose === 'view') {
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

/**
 * Refuses an edit by anyone but the org's owner, with 403. The network admin
 * views other owners' details but does not change them.
 *
 * @throws {HttpError} FORBIDDEN.
 */
function requireOwner(actor: Actor, org: Organisation): void {
  if (org.ownerUserId !== actor.userId) throw httpError('FORBIDDEN');
}

/** The instance's organisation settings, from the network config. */
async function organisationConfig(): Promise<OrganisationConfig> {
  return (await getNetworkConfig()).aggregator.organisation;
}

/**
 * Whether the actor may set the org's `known_as`: the parent is an active org
 * the actor owns, or the parent is the root and the actor is the network admin.
 * Never for the root or the Default org.
 *
 * @throws {HttpError} DB_UNAVAILABLE when the root cannot be read.
 */
async function ownsParentOf(actor: Actor, org: Organisation): Promise<boolean> {
  if (org.parentId === null || org.isDefault) return false;
  if (ownedOrgIds(actor).includes(org.parentId)) return true;
  if (!isNetworkAdmin(actor)) return false;
  const root = await getOrganisationStore().findRoot();
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  return root.value?.id === org.parentId;
}

/**
 * Reads the "known as" list of an org or the root.
 *
 * @param id - The org id.
 * @returns The list; empty when the org is not found.
 * @throws {HttpError} DB_UNAVAILABLE.
 */
async function knownAsValuesOf(id: string): Promise<KnownAsValues> {
  const store = getOrganisationStore();
  const found = await store.findById(id);
  if (!found.ok) dbDown('orgStore.findById', found.error.message);
  if (found.value) return found.value.knownAsValues;
  const root = await store.findRoot();
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  return root.value?.id === id ? root.value.knownAsValues : [];
}

/**
 * The values the actor can pick for the org's `known_as`, or null when it
 * cannot set it (see {@link ownsParentOf}; a rejected org is not changed).
 *
 * @throws {HttpError} DB_UNAVAILABLE.
 */
async function knownAsOptionsFor(actor: Actor, org: Organisation): Promise<KnownAsEntry[] | null> {
  if (org.status === 'inactive' || !(await ownsParentOf(actor, org))) return null;
  return knownAsChoices(await knownAsValuesOf(org.parentId!));
}

/**
 * Maps a refused move from the store to its HTTP error.
 *
 * @param e - The store error.
 * @param subOperation - The store call, for a `DB_UNAVAILABLE` log.
 * @throws {HttpError} Always.
 */
function throwTreeError(e: OrgStoreError, subOperation: string): never {
  if (e.code === 'NOT_FOUND') throw httpError('NOT_FOUND');
  throwTreeRefusal(e);
  dbDown(subOperation, e.message);
}

/**
 * Maps a refused "known as" write from the store to its HTTP error.
 *
 * @param e - The store error.
 * @param subOperation - The store call, for a `DB_UNAVAILABLE` log.
 * @throws {HttpError} Always.
 */
function throwKnownAsError(e: OrgStoreError, subOperation: string): never {
  switch (e.code) {
    case 'NOT_FOUND':
      throw httpError('NOT_FOUND');
    case 'KNOWN_AS_INVALID':
      throw httpError('SCHEMA_VALIDATION', {
        detail: "known_as is not one of the parent organisation's values.",
        fields: { known_as: 'invalid' },
      });
    case 'ORG_MOVED':
      throw httpError('CONFLICT', {
        detail: 'The organisation was moved. Reload and try again.',
        fields: { reason: 'moved' },
      });
    case 'KNOWN_AS_UNKNOWN_KEY':
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'A value sent a key that is not saved. Send no key for a new value.',
        fields: { known_as_values: 'unknown_key', index: e.index },
      });
    case 'NOT_EDITABLE':
      throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
    default:
      dbDown(subOperation, e.message);
  }
}

/**
 * Reads the hierarchy response: the network with its "known as" list, the
 * tree limits and the org total.
 *
 * @throws {HttpError} DB_UNAVAILABLE when the root or the total cannot be read.
 */
async function readHierarchy(): Promise<OrgHierarchyResponse> {
  const store = getOrganisationStore();
  const [root, total] = await Promise.all([store.findRoot(), store.countTotal()]);
  if (!root.ok) dbDown('orgStore.findRoot', root.error.message);
  if (!root.value) dbDown('orgStore.findRoot', 'network root missing');
  if (!total.ok) dbDown('orgStore.countTotal', total.error.message);
  const { hierarchy } = await organisationConfig();
  return {
    network: {
      id: root.value.id,
      name: root.value.displayName,
      known_as_values: root.value.knownAsValues,
    },
    limits: {
      max_depth: hierarchy.max_depth,
      max_children: hierarchy.max_children ?? null,
      max_total_orgs: hierarchy.max_total_orgs,
    },
    total_orgs: total.value,
  };
}

/** Pending and active direct children per org; throws `DB_UNAVAILABLE` on a store failure. */
async function childCountsOf(ids: string[]): Promise<Record<string, number>> {
  const counts = await getOrganisationStore().childCounts(ids);
  if (!counts.ok) dbDown('orgStore.childCounts', counts.error.message);
  return counts.value;
}

/**
 * Replaces the "known as" values an org defines for its direct children.
 * Only the org's owner may, or the network admin for the root.
 *
 * @param found - The org, already in the actor's view reach.
 * @param values - The new list from the request.
 * @throws {HttpError} CONFLICT for the Default org, FORBIDDEN for a non-owner, and the store refusals.
 */
async function setKnownAsValues(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  { org, orgType }: FoundOrg,
  values: KnownAsValuesRequest,
): Promise<FastifyReply> {
  if (orgType === 'aggregator') {
    if (org.isDefault) {
      throw httpError('CONFLICT', { detail: "This organisation's details are not editable." });
    }
    if (!ownedOrgIds(actor).includes(org.id)) throw httpError('FORBIDDEN');
  }
  await guardWriteRate(actor, reply);

  const updated = await getOrganisationStore().setKnownAsValues(org.id, values, actor.userId);
  if (!updated.ok) throwKnownAsError(updated.error, 'orgStore.setKnownAsValues');
  req.log.info({
    operation: 'console.org.known_as_values',
    status: 'success',
    actor_id: actor.userId,
    target_id: org.id,
    value_count: updated.value.org.knownAsValues.length,
    reset_count: updated.value.resetCount,
  });
  return reply.status(200).send(toWireOrg(updated.value.org, orgType));
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
          'An owner also reads, read-only, every organisation below its own; the owner contact of such an organisation is masked. known_as_options lists the values the caller can pick for the org\'s known_as (the parent\'s list, or only "aggregator" when that list is empty); it is null unless the caller owns the parent (the network admin for a top-level organisation). org.known_as_values is null when the organisation cannot have child organisations: the Default organisation, or an organisation at max_depth.',
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
      const children = await childCountsOf([org.id]);
      const { hierarchy } = await organisationConfig();
      const isRoot = orgType === 'network_facilitator';
      req.log.info({
        operation: 'console.org.read',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        relation: below ? 'below' : 'own',
      });
      const childrenAllowed = isRoot || (!org.isDefault && org.depth < hierarchy.max_depth);
      const wireOrg = toWireOrg(org, orgType);
      return reply.status(200).send({
        org: childrenAllowed ? wireOrg : { ...wireOrg, known_as_values: null },
        // An org only viewed from above shows its owner's contact masked.
        owner: { id: org.ownerUserId, contact: ownerContact(org, { masked: below }) },
        coordinator_count: c?.total ?? 0,
        child_count: children[org.id] ?? 0,
        pending_count: c?.pending ?? 0,
        known_as_options: isRoot ? null : await knownAsOptionsFor(actor, org),
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
          'The network admin sees every aggregator organisation; an owner sees the ones it owns and, read-only, every one below them. With `descendants_of` set to an org within reach, lists every org below it instead (read-only). Filters by status and a case-insensitive name prefix; keyset paged by an opaque cursor.',
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
      const page = await getOrganisationStore().search({
        orgIds,
        ...(below ? { descendantsOf: below } : {}),
        ...(body.filter.status ? { status: body.filter.status } : {}),
        ...(body.filter.name_prefix ? { namePrefix: body.filter.name_prefix } : {}),
        ...(body.cursor ? { cursor: decodeOrgCursor(body.cursor) } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });
      if (!page.ok) dbDown('orgStore.search', page.error.message);
      const ids = page.value.rows.map((o) => o.id);
      const counts = await getUserStore().countByOrg(ids);
      if (!counts.ok) dbDown('userStore.countByOrg', counts.error.message);
      const children = await childCountsOf(ids);
      return reply.status(200).send({
        orgs: page.value.rows.map((o) => ({
          ...toWireOrg(o),
          coordinator_count: counts.value[o.id]?.total ?? 0,
          child_count: children[o.id] ?? 0,
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
          "Every field, the name included, is the org's owner's only (the slug never changes); the network admin views other owners' orgs but does not edit them (403). known_as changes through PATCH /v1/org/known-as/update/:id and the parent through PATCH /v1/org/parent/update/:id. The Default org's details are not editable. `profile` changes fields of the deployment's org-registration schema (e.g. website, GST number, domains): only fields marked x-updatable, checked against that schema; null removes a field. A bad field answers 400 with fields.field_errors and saves nothing. Locations, legal name, website and GST number are rendered for every coordinator of the org; description is shown in the console only.",
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
      requireOwner(actor, org);
      // Schema fields: only those marked x-updatable, checked against the schema.
      let profileMerge: Record<string, unknown> | undefined;
      if (body.profile !== undefined) {
        const checked = await validateOrgUpdate(body.profile);
        if (!checked.ok) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: Object.entries(checked.errors)
              .map(([field, message]) => `${field}: ${message}`)
              .join('; '),
            fields: { field_errors: checked.errors },
          });
        }
        profileMerge = checked.values;
      }
      await guardWriteRate(actor, reply);

      const patch: UpdateOrgPatch = { updatedBy: actor.userId };
      if (body.name !== undefined) patch.displayName = body.name;
      if (body.locations !== undefined) patch.locations = body.locations;
      if (body.legal_name !== undefined) patch.legalName = body.legal_name;
      // An empty description is stored as "none".
      if (body.description !== undefined) patch.description = body.description || null;
      if (profileMerge) patch.profileMerge = profileMerge;

      const updated = await getOrganisationStore().update(org.id, patch);
      if (!updated.ok) {
        if (updated.error.code === 'DUPLICATE_NAME') throw httpError('ORG_NAME_TAKEN');
        throwTreeError(updated.error, 'orgStore.update');
      }
      const fields = Object.keys(body);
      req.log.info({
        operation: 'console.org.update',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        fields,
      });
      return reply.status(200).send(toWireOrg(updated.value));
    },
  );

  app.patch(
    '/v1/org/known-as/update/:id',
    {
      config: { rbac: { anyCapability: ['org.manage', 'orgs.onboard'] } },
      schema: {
        tags: ['console'],
        summary:
          'Set what an organisation is known as, or the "known as" values it defines for the organisations under it',
        description:
          'The body has exactly one of known_as or known_as_values. An organisation the caller cannot see answers 404.\n\n' +
          "known_as sets the organisation's own value. Only the owner of the organisation's parent sets it: the network admin for a top-level organisation, else the owner of the parent organisation (an active organisation it owns); anyone else gets 403. known_as must be a key of the parent's list, or aggregator when that list is empty (400 SCHEMA_VALIDATION with fields.known_as otherwise). The network, the Default organisation and a rejected organisation answer 409, and so does an organisation moved while the request ran (fields.reason: moved). The organisation's owner is emailed when it is not the caller. Sending the current value answers 200 with the organisation unchanged and sends no email.\n\n" +
          "known_as_values replaces the whole list the organisation defines for its direct children. Only the organisation's owner sets it (an active organisation it owns; the network's list for the network admin): 403 when the caller sees but does not own it, 409 for the Default organisation. An entry that is already saved sends its key back and keeps it; a new entry sends only a name, and the API makes its key from the name. A key that is not already in the list answers 400 SCHEMA_VALIDATION (fields.known_as_values: unknown_key, fields.index). At most one entry is the default; new organisations under this one get it, else aggregator. Organisations under this one whose value leaves the list take the default, else aggregator; a renamed entry keeps its key, so they keep it too.",
        params: IdParamsSchema,
        body: OrgKnownAsUpdateRequestSchema,
        response: { 200: OrgSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as OrgKnownAsUpdateRequest;
      const { org, orgType } = await orgInReach(actor, id, 'view');
      if ('known_as_values' in body) {
        return setKnownAsValues(req, reply, actor, { org, orgType }, body.known_as_values);
      }
      if (orgType !== 'aggregator' || org.isDefault || org.status === 'inactive') {
        throw httpError('CONFLICT', {
          detail: 'What this organisation is known as cannot be changed.',
        });
      }
      if (!(await ownsParentOf(actor, org))) throw httpError('FORBIDDEN');
      // The org already has this value: nothing is written and no one is emailed.
      if (body.known_as === org.knownAs) return reply.status(200).send(toWireOrg(org));
      await guardWriteRate(actor, reply);

      const updated = await getOrganisationStore().setKnownAs(
        org.id,
        body.known_as,
        org.parentId!,
        actor.userId,
      );
      if (!updated.ok) throwKnownAsError(updated.error, 'orgStore.setKnownAs');
      req.log.info({
        operation: 'console.org.known_as',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        parent_id: org.parentId,
      });
      await notifyOwnerOfParentAction(actor, updated.value, req.log);
      return reply.status(200).send(toWireOrg(updated.value));
    },
  );

  app.patch(
    '/v1/org/parent/update/:id',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Move an organisation under a new parent (network admin)',
        description:
          "Moves the organisation and every organisation below it; their depths follow. The org must be pending or active, not the Default org. The parent must be the network or an active organisation, not the org or one below it, with room for another child, and the moved orgs must stay within max_depth. The moved org keeps its known_as when the new parent's list has it; otherwise it takes the new parent's default value, else aggregator. Organisations below it keep theirs. The owner is told when the org moved.",
        params: IdParamsSchema,
        body: OrgParentUpdateRequestSchema,
        response: { 200: OrgSchema, ...errorResponses(400, 401, 403, 404, 409, 429, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgParentUpdateRequestSchema>;
      const orgCfg = await organisationConfig();
      await guardWriteRate(actor, reply);

      const moved = await getOrganisationStore().move(
        id,
        { parentId: body.parent_id },
        treeRules(orgCfg),
      );
      if (!moved.ok) throwTreeError(moved.error, 'orgStore.move');
      const { org, oldParentId, movedCount } = moved.value;
      req.log.info({
        operation: 'console.org.move',
        status: 'success',
        actor_id: actor.userId,
        target_id: org.id,
        old_parent_id: oldParentId,
        new_parent_id: org.parentId,
        moved_count: movedCount,
      });
      if (movedCount > 0) {
        await notifyOwnerOfAdminAction(
          actor,
          org,
          `moved the organisation under ${org.parentName ?? 'the network'}`,
          req.log,
        );
      }
      return reply.status(200).send(toWireOrg(org));
    },
  );

  app.get(
    '/v1/org/parent/options/:id',
    {
      config: { rbac: { capability: 'network.administer' } },
      schema: {
        tags: ['console'],
        summary: 'Candidate parents for moving an organisation (network admin)',
        description:
          'Every org that could be the new parent, the network first, each with the result a move there would give: ok, or the refusal code in reason (INVALID_PARENT, PARENT_CYCLE, CHILD_LIMIT, DEPTH_LIMIT, or NOT_MOVABLE). subtree_size counts the orgs that move.',
        params: IdParamsSchema,
        response: { 200: OrgParentOptionsResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      requireNetworkAdmin(actor);
      const { id } = req.params as IdParams;
      const orgCfg = await organisationConfig();
      const result = await getOrganisationStore().parentOptions(id, treeRules(orgCfg));
      if (!result.ok) throwTreeError(result.error, 'orgStore.parentOptions');
      return reply.status(200).send({
        subtree_size: result.value.subtreeSize,
        options: result.value.options.map(({ org, ok, reason }) => ({
          id: org.id,
          name: org.displayName,
          depth: org.depth,
          known_as_name: org.depth === 0 ? null : org.knownAsName,
          ok,
          reason,
        })),
      });
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
        summary: 'The network, its "known as" values and the tree limits (network admin)',
        description:
          'Read-only. The network with the "known as" values it defines for top-level organisations (edited through PATCH /v1/org/known-as/update/:id with known_as_values), the tree limits from the instance config, and how many pending and active organisations count toward max_total_orgs. Depth 1 sits directly under the network.',
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
