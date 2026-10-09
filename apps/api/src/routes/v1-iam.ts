/**
 * RBAC grant and PermissionSet routes (`@aggregator-dpg/api`, R3).
 *
 *   GET   /v1/user/grants/:id                 a coordinator's grants and what may be granted
 *   POST  /v1/user/grant/:id                  grant (e.g. PII Access) to a coordinator
 *   POST  /v1/user/grant/revoke/:id           revoke a coordinator's live grant
 *   GET   /v1/org/permission-sets             the PermissionSets of this instance
 *   PATCH /v1/org/permission-set/update/:id   set an organisation's own PermissionSet
 *
 * `requireActor()` checks the declared capability first; the rules that need
 * the target (reach → 404, subset, no self-grant, parent only) are in
 * `services/authz/grants.ts`. Every change is written to `iam_audit`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  GrantRequestSchema,
  OrgPermissionSetRequestSchema,
  OrgPermissionSetResponseSchema,
  PermissionGrantSchema,
  PermissionSetsResponseSchema,
  RevokeGrantRequestSchema,
  RevokeGrantResponseSchema,
  UserGrantsResponseSchema,
  type PermissionGrant as WireGrant,
} from '@aggregator-dpg/shared-primitives/user-org';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { requireActor } from '../services/auth/actor/index.js';
import { getRbacRuntime } from '../services/authz/runtime.js';
import {
  grantToUser,
  listUserGrants,
  revokeFromUser,
  setOrgPermissionSet,
  type GrantFailure,
} from '../services/authz/grants.js';
import type { PermissionGrant } from '../services/grant-store/index.js';
import { guardWriteRate } from './console-shared.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });
type IdParams = z.infer<typeof IdParamsSchema>;

/** A stored grant on the wire. */
function toWireGrant(g: PermissionGrant, now: Date): WireGrant {
  return {
    grant_key: g.grantKey,
    capability: g.capability,
    granted_at: g.grantedAt.toISOString(),
    expires_at: g.expiresAt.toISOString(),
    granted_by: g.grantedBy,
    revoked_at: g.revokedAt ? g.revokedAt.toISOString() : null,
    live: g.revokedAt === null && g.expiresAt > now,
  };
}

/** Throws the HTTP error for a failed rule check. */
function throwFailure(f: GrantFailure): never {
  switch (f.kind) {
    case 'rbac_off':
      throw httpError('RBAC_NOT_ENABLED');
    case 'not_found':
      throw httpError('NOT_FOUND');
    case 'not_allowed':
      if (f.reason === 'parent_only') {
        throw httpError('FORBIDDEN', { fields: { reason: 'parent_only' } });
      }
      throw httpError('PERMISSION_GRANT_NOT_ALLOWED', { fields: { reason: f.reason } });
    case 'exceeds_org_set':
      throw httpError('PERMISSION_GRANT_EXCEEDS_ORG_SET', { fields: { capability: f.capability } });
    case 'unknown_set':
      throw httpError('PERMISSION_SET_UNKNOWN');
    case 'unavailable':
      throw httpError('DB_UNAVAILABLE', {
        cause: new Error(f.message),
        fields: { sub_operation: 'rbac.grants' },
      });
  }
}

/**
 * Registers the RBAC grant and PermissionSet routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerV1IamRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/user/grants/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: "A coordinator's grants and what may be granted",
        params: IdParamsSchema,
        response: { 200: UserGrantsResponseSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      const { id } = req.params as IdParams;
      const res = await listUserGrants(actor, id);
      if (!res.ok) throwFailure(res.failure);
      const now = new Date();
      return reply.status(200).send({
        grants: res.value.grants.map((g) => toWireGrant(g, now)),
        grantable: res.value.grantable.map((g) => ({
          grant_key: g.grantKey,
          capability: g.capability,
          max_days: g.maxDays,
        })),
      });
    },
  );

  app.post(
    '/v1/user/grant/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: 'Grant a capability (e.g. PII Access) to a coordinator',
        description:
          "Replaces the coordinator's live grant of the same key. Refused for a capability the coordinator's organisation does not hold, for yourself, and beyond the grant's longest validity.",
        params: IdParamsSchema,
        body: GrantRequestSchema,
        response: {
          200: PermissionGrantSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof GrantRequestSchema>;
      const res = await grantToUser(actor, id, body.grant_key, body.days);
      if (!res.ok) throwFailure(res.failure);
      req.log.info({
        operation: 'rbac.grant',
        status: 'success',
        actor_id: actor.userId,
        target_id: id,
        grant_key: body.grant_key,
      });
      return reply.status(200).send(toWireGrant(res.value, new Date()));
    },
  );

  app.post(
    '/v1/user/grant/revoke/:id',
    {
      config: { rbac: { capability: 'org.manage' } },
      schema: {
        tags: ['console'],
        summary: "Revoke a coordinator's live grant",
        params: IdParamsSchema,
        body: RevokeGrantRequestSchema,
        response: {
          200: RevokeGrantResponseSchema,
          ...errorResponses(400, 401, 403, 404, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof RevokeGrantRequestSchema>;
      const res = await revokeFromUser(actor, id, body.grant_key);
      if (!res.ok) throwFailure(res.failure);
      req.log.info({
        operation: 'rbac.revoke',
        status: 'success',
        actor_id: actor.userId,
        target_id: id,
        grant_key: body.grant_key,
        revoked: res.value,
      });
      return reply.status(200).send({ revoked: res.value });
    },
  );

  app.get(
    '/v1/org/permission-sets',
    {
      config: { rbac: { capability: 'orgs.onboard' } },
      schema: {
        tags: ['console'],
        summary: 'The PermissionSets of this instance (rbac.yaml)',
        response: { 200: PermissionSetsResponseSchema, ...errorResponses(401, 403, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      await requireActor(req);
      const rt = getRbacRuntime();
      if (!rt) throw httpError('RBAC_NOT_ENABLED');
      return reply.status(200).send({
        sets: Object.entries(rt.config.permission_sets)
          .map(([name, capabilities]) => ({ name, capabilities: [...capabilities] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        defaults: { ...rt.config.org_type_defaults },
      });
    },
  );

  app.patch(
    '/v1/org/permission-set/update/:id',
    {
      config: { rbac: { capability: 'orgs.onboard' } },
      schema: {
        tags: ['console'],
        summary: "Set an organisation's own PermissionSet",
        description:
          "A key of rbac.yaml permission_sets, or null for the org_type default. Only a parent sets a child organisation's set; today that is the network admin.",
        params: IdParamsSchema,
        body: OrgPermissionSetRequestSchema,
        response: {
          200: OrgPermissionSetResponseSchema,
          ...errorResponses(400, 401, 403, 404, 429, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { actor } = await requireActor(req);
      await guardWriteRate(actor, reply);
      const { id } = req.params as IdParams;
      const body = req.body as z.infer<typeof OrgPermissionSetRequestSchema>;
      const res = await setOrgPermissionSet(actor, id, body.permission_set);
      if (!res.ok) throwFailure(res.failure);
      req.log.info({
        operation: 'rbac.orgPermissionSet',
        status: 'success',
        actor_id: actor.userId,
        target_id: id,
        permission_set: res.value.permissionSet,
      });
      return reply.status(200).send({
        id: res.value.id,
        permission_set: res.value.permissionSet,
        capabilities: res.value.capabilities,
      });
    },
  );
}
