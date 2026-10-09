/**
 * Console user routes `/v1/user/*` (`@aggregator-dpg/api`, user & org Phase 5).
 *
 *   GET   /v1/user/read/me               the signed-in actor (web routing)
 *   GET   /v1/user/read/:id              one coordinator within reach
 *   POST  /v1/user/search                coordinators within reach, keyset paged
 *   POST  /v1/user/create                invite coordinators into an org
 *   POST  /v1/user/decision/:id          approve / reject a pending coordinator
 *   PATCH /v1/user/metadata/update/:id   change a coordinator's domains
 *
 * Every handler calls `requireActor` first. Only `read/me` admits a
 * coordinator; the rest are for org owners (their orgs) and the network admin
 * (every org). A target out of reach answers 404 (`services/authz/scope.ts`).
 * Contact data is plain within reach (P5-8); single reads are audit-logged.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  MeResponseSchema,
  UserInviteRequestSchema,
  UserInviteResponseSchema,
  UserMetadataUpdateRequestSchema,
  UserSchema,
  UserSearchRequestSchema,
  UserSearchResponseSchema,
  type MeOrg,
  type MeResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { getMailer } from '@aggregator-dpg/mailer';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { getAggregatorStore, type Aggregator } from '../services/aggregator-store/index.js';
import {
  getAggregatorOrgStore,
  type AggregatorOrg,
} from '../services/aggregator-org-store/index.js';
import { isNetworkAdmin, requireActor, type Actor } from '../services/auth/actor/index.js';
import { reachesOrg, scopeOrgFilter } from '../services/authz/scope.js';
import { decideCoordinator } from '../services/decisions/coordinator.js';
import { mintInviteBatch } from '../services/invites/mint.js';
import { checkInviteMintRate } from '../services/invite-mint-rate.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getNetworkConfig } from '../services/network-config.js';
import {
  decodeUserCursor,
  encodeUserCursor,
  guardWriteRate,
  notifyOwnerOfAdminAction,
  ownerContact,
  throwDecisionFailure,
  toWireUser,
} from './console-shared.js';
import { checkCapability, listActorCapabilities } from '../services/authz/index.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
type IdParams = z.infer<typeof IdParamsSchema>;

/** Throws `DB_UNAVAILABLE` naming the failed store call. */
function dbDown(subOperation: string, message: string): never {
  throw httpError('DB_UNAVAILABLE', {
    cause: new Error(message),
    fields: { sub_operation: subOperation },
  });
}

/**
 * Loads a coordinator within the actor's reach, else 404.
 *
 * @throws {HttpError} NOT_FOUND / DB_UNAVAILABLE.
 */
async function coordinatorInReach(actor: Actor, id: string): Promise<Aggregator> {
  const row = await getAggregatorStore().findById(id);
  if (!row.ok) dbDown('aggregatorStore.findById', row.error.message);
  if (!row.value || !reachesOrg(actor, row.value.parentOrgId)) throw httpError('NOT_FOUND');
  return row.value;
}

/**
 * Loads an aggregator org by id, else 404.
 *
 * @throws {HttpError} NOT_FOUND / DB_UNAVAILABLE.
 */
async function loadOrg(id: string): Promise<AggregatorOrg> {
  const org = await getAggregatorOrgStore().findById(id);
  if (!org.ok) dbDown('orgStore.findById', org.error.message);
  if (!org.value) throw httpError('NOT_FOUND');
  return org.value;
}

/**
 * Builds the `read/me` answer for an actor.
 *
 * @throws {HttpError} DB_UNAVAILABLE.
 */
/**
 * Whether contact details are shown plain to this actor (RBAC
 * `contact.unmask`; handoff H-6). True when access control is off or only
 * logging, so behaviour changes only under `enforce`.
 */
async function showsContact(req: FastifyRequest, actor: Actor): Promise<boolean> {
  return (await checkCapability(req, actor, 'contact.unmask')).allowed;
}

async function meOf(req: FastifyRequest, actor: Actor): Promise<MeResponse> {
  const orgStore = getAggregatorOrgStore();
  const orgs: MeOrg[] = [];
  let self: { name: string | null; email: string; phone: string | null } | null = null;

  if (actor.userType === 'coordinator') {
    const row = await getAggregatorStore().findById(actor.userId);
    if (!row.ok) dbDown('aggregatorStore.findById', row.error.message);
    if (!row.value) throw httpError('USER_NOT_PROVISIONED');
    self = {
      name: row.value.contact.name ?? null,
      email: row.value.contact.email,
      phone: row.value.contact.phone ?? null,
    };
  }

  for (const o of actor.orgs) {
    const found =
      o.orgType === 'network_facilitator'
        ? await orgStore.findRoot()
        : await orgStore.findById(o.id);
    if (!found.ok) dbDown('orgStore.findById', found.error.message);
    if (!found.value) continue;
    orgs.push({
      id: found.value.id,
      name: found.value.displayName,
      slug: found.value.slug,
      org_type: o.orgType,
      role: o.relation,
      is_default: found.value.isDefault,
    });
    // An admin's own contact is its orgs' owner contact (one person).
    if (!self && o.relation === 'owner') self = ownerContact(found.value);
  }
  if (!self) throw httpError('USER_NOT_PROVISIONED');

  return {
    kind: actor.userType,
    user: { id: actor.userId, contact: self },
    orgs,
    is_network_admin: isNetworkAdmin(actor),
    capabilities: await listActorCapabilities(req, actor),
  };
}

/**
 * Registers the `/v1/user/*` console routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1UserRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/user/read/me',
    {
      config: { rbac: { access: 'signed_in' } },
      schema: {
        tags: ['console'],
        summary: 'The signed-in user: kind, organisations and network-admin flag',
        response: { 200: MeResponseSchema, ...errorResponses(401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req, { allowCoordinator: true });
      return reply.status(200).send(await meOf(req, actor));
    },
  );

  app.get(
    '/v1/user/read/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'One coordinator within reach',
        params: IdParamsSchema,
        response: { 200: UserSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const row = await coordinatorInReach(actor, id);
      const plain = await showsContact(req, actor);
      // Contact read audit (design C8): ids only.
      req.log.info({
        operation: 'console.user.read',
        status: 'success',
        actor_id: actor.userId,
        target_id: row.id,
        contact: plain ? 'plain' : 'masked',
      });
      return reply.status(200).send(toWireUser(row, { masked: !plain }));
    },
  );

  app.post(
    '/v1/user/search',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Coordinators within reach, newest first',
        description:
          'Filters by org, status and served domain; an org outside reach yields an empty page. Keyset paged by an opaque cursor.',
        body: UserSearchRequestSchema,
        response: { 200: UserSearchResponseSchema, ...errorResponses(400, 401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const body = req.body as z.infer<typeof UserSearchRequestSchema>;
      const page = await getAggregatorStore().search({
        orgIds: scopeOrgFilter(actor, body.filter.org_id),
        ...(body.filter.status ? { status: body.filter.status } : {}),
        ...(body.filter.serves ? { serves: body.filter.serves } : {}),
        ...(body.cursor ? { cursor: decodeUserCursor(body.cursor) } : {}),
        ...(body.limit ? { limit: body.limit } : {}),
      });
      if (!page.ok) dbDown('aggregatorStore.search', page.error.message);
      const plain = await showsContact(req, actor);
      if (plain && page.value.rows.length > 0) {
        // Plain contact in a list: audited by count, never values (H-6).
        req.log.info({
          operation: 'console.user.search',
          status: 'success',
          actor_id: actor.userId,
          contact: 'plain',
          count: page.value.rows.length,
        });
      }
      return reply.status(200).send({
        users: page.value.rows.map((row) => toWireUser(row, { masked: !plain })),
        next_cursor: page.value.nextCursor ? encodeUserCursor(page.value.nextCursor) : null,
      });
    },
  );

  app.post(
    '/v1/user/create',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Invite coordinators into an organisation',
        description:
          'Mints and mails a 14-day invite per address (the invitee registers and consents themselves). The Default org takes no invites. An address already registered in this org is reported under `existing`; any other existing account is mailed a sign-in note and counted as sent.',
        body: UserInviteRequestSchema,
        response: {
          200: UserInviteResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const body = req.body as z.infer<typeof UserInviteRequestSchema>;
      if (!reachesOrg(actor, body.org_id)) throw httpError('NOT_FOUND');
      if (body.recipients.length > config.INVITE_MINT_MAX_RECIPIENTS) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `At most ${config.INVITE_MINT_MAX_RECIPIENTS} recipients per request.`,
          fields: { field: 'recipients' },
        });
      }
      const org = await loadOrg(body.org_id);
      // The Default org takes no invites, for every principal (design R8).
      if (org.status !== 'active' || org.isDefault) throw httpError('TARGET_ORG_INACTIVE');

      const rl = await checkInviteMintRate(org.id, body.recipients.length);
      if (!rl.allowed) {
        void reply.header('Retry-After', String(rl.retryAfterSeconds));
        throw httpError('RATE_LIMITED', {
          detail: `Retry in ${rl.retryAfterSeconds}s.`,
          fields: { retry_after_seconds: rl.retryAfterSeconds },
        });
      }

      const log = req.log.child({ operation: 'console.user.invite', actor_id: actor.userId });
      const summary = await mintInviteBatch({
        invites: getRegistrationInvitesStore(),
        mailer: getMailer(),
        orgId: org.id,
        orgName: org.displayName,
        inviterEmail: org.ownerEmail,
        recipients: body.recipients,
        ttlSec: config.INVITE_TOKEN_TTL_SECONDS,
        createdBy: actor.userId,
        log,
      });
      log.info({
        status: 'success',
        org_id: org.id,
        sent: summary.sent,
        resent: summary.resent,
        invalid: summary.invalid.length,
        existing: summary.existing.length,
      });
      // The invite mail names the org's owner as the inviter (C13).
      if (summary.sent + summary.resent > 0) {
        await notifyOwnerOfAdminAction(actor, org, 'invited coordinators', req.log);
      }
      return reply.status(200).send(summary);
    },
  );

  app.post(
    '/v1/user/decision/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Approve or reject a pending coordinator',
        description:
          'The same compare-and-set decision service as the emailed review link. A decision already made answers 409 ALREADY_DECIDED with status, decided_at and decided_by.',
        params: IdParamsSchema,
        body: DecisionRequestSchema,
        response: {
          200: DecisionResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 502, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof DecisionRequestSchema>;
      const row = await coordinatorInReach(actor, id);
      await guardWriteRate(actor, reply);

      const outcome = await decideCoordinator({
        aggregatorId: row.id,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
        decidedBy: actor.userId,
        requestId: req.id,
        log: req.log.child({ actor_id: actor.userId }),
      });
      if (outcome.kind !== 'decided') throwDecisionFailure(outcome);

      if (row.parentOrgId) {
        const org = await getAggregatorOrgStore().findById(row.parentOrgId);
        if (org.ok && org.value) {
          await notifyOwnerOfAdminAction(
            actor,
            org.value,
            body.decision === 'approve' ? 'approved a coordinator' : 'rejected a coordinator',
            req.log,
          );
        }
      }
      return reply.status(200).send({
        id: row.id,
        status: body.decision === 'approve' ? 'active' : 'inactive',
        notified: outcome.notified,
      });
    },
  );

  app.patch(
    '/v1/user/metadata/update/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: "Change a coordinator's served domains",
        description:
          "`serves` lists network domain ids (`[]` = every domain). For an approved coordinator the Signals organisation's domains are updated first.",
        params: IdParamsSchema,
        body: UserMetadataUpdateRequestSchema,
        response: { 200: UserSchema, ...errorResponses(400, 401, 403, 404, 429, 502, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof UserMetadataUpdateRequestSchema>;
      const row = await coordinatorInReach(actor, id);
      await guardWriteRate(actor, reply);

      const networkCfg = await getNetworkConfig();
      const serves = [...new Set(body.serves)];
      const unknown = serves.filter((d) => !networkCfg.domainIds.includes(d));
      if (unknown.length > 0) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'serves lists a domain this network does not have.',
          fields: { field: 'serves', unknown },
        });
      }
      const log = req.log.child({
        operation: 'console.user.update',
        actor_id: actor.userId,
        target_id: row.id,
      });

      // An approved coordinator's Signals org carries its domains: update it
      // first, so a Signals failure leaves both sides unchanged.
      const signalstack = getSignalStackWriter();
      const pushDomains = async (): Promise<boolean> => {
        if (!signalstack) return true;
        const upsert = await signalstack.upsertAggregator({
          external_id: row.id,
          name: row.name,
          slug: row.orgSlug,
          domains: serves.length > 0 ? serves : networkCfg.domainIds,
          requestId: req.id,
        });
        if (!upsert.success) {
          log.error({
            status: 'failure',
            sub_operation: 'signalstack.upsertAggregator',
            code: upsert.error.code,
          });
        }
        return upsert.success;
      };
      if (row.status === 'active' && !(await pushDomains())) {
        throw httpError('SIGNALSTACK_PUSH_FAILED');
      }

      const updated = await getAggregatorStore().update(row.id, {
        serves,
        updatedBy: actor.userId,
      });
      if (!updated.ok) dbDown('aggregatorStore.update', updated.error.message);
      // Approved meanwhile (the approval pushed the old domains): push again.
      if (row.status !== 'active' && updated.value.status === 'active' && !(await pushDomains())) {
        throw httpError('SIGNALSTACK_PUSH_FAILED', {
          detail: 'The domains were saved, but Signals was not updated. Save them again.',
        });
      }
      log.info({ status: 'success', fields: ['serves'] });

      if (row.parentOrgId) {
        const org = await getAggregatorOrgStore().findById(row.parentOrgId);
        if (org.ok && org.value) {
          await notifyOwnerOfAdminAction(
            actor,
            org.value,
            "changed a coordinator's domains",
            req.log,
          );
        }
      }
      return reply
        .status(200)
        .send(toWireUser(updated.value, { masked: !(await showsContact(req, actor)) }));
    },
  );
}
