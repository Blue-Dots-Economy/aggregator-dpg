/**
 * Org registration endpoints (spec §6.1 / §6 dropdown).
 *
 * Flag-gated by `ORG_HIERARCHY_ENABLED`: when the flag is OFF these routes are
 * not registered at all (Fastify returns 404), so flag-off behaviour is
 * unchanged. When ON:
 *
 *   POST /v1/orgs/create
 *     Inserts a `pending` `aggregator_orgs` row (system of record), creates the
 *     mirrored KC group + a disabled org-owner KC user, and emails the network
 *     admin a signed approve/reject review link. No signalstack org.
 *
 *   GET /v1/orgs
 *     Lists active orgs for the coordinator-registration dropdown — plain SQL
 *     on `aggregator_orgs WHERE status='active'`, no Keycloak admin API (A5).
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { orgHierarchyEnabled } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import { sendOrgReviewEmail } from '../services/org-registration-notify.js';
import { normalisePhone } from '../services/phone.js';
import { slugFromName } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const OrgCreateBodySchema = z.object({
  display_name: z.string().min(1).max(200),
  state: z.string().max(200).optional(),
  owner: z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    phone: z.string().min(1),
  }),
  consent: z.object({
    value: z.boolean(),
    given_at: z.string(),
    valid_till: z.string(),
  }),
});

const OrgCreatedResponseSchema = z
  .object({
    org_id: z.string(),
    slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

const OrgListResponseSchema = z
  .object({
    orgs: z.array(z.object({ id: z.string(), slug: z.string(), display_name: z.string() })),
  })
  .passthrough();

/**
 * Registers the org registration + dropdown routes. No-op (routes absent) when
 * `ORG_HIERARCHY_ENABLED` is false, so flag-off deployments behave as today.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export async function registerAggregatorOrgRoutes(app: FastifyInstance): Promise<void> {
  if (!orgHierarchyEnabled()) return;

  app.post(
    '/v1/orgs/create',
    {
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Submit a new parent-org registration',
        description:
          'Creates a pending org (system of record) + mirrored Keycloak group + disabled org-owner user, and emails the network admin a signed review link. Only registered when ORG_HIERARCHY_ENABLED=true.',
        body: OrgCreateBodySchema,
        response: { 201: OrgCreatedResponseSchema, ...errorResponses(400, 401, 409, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'org-registration.create' });
      const start = Date.now();

      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }

      const body = req.body as z.infer<typeof OrgCreateBodySchema>;

      const phoneResult = normalisePhone(body.owner.phone);
      if (!phoneResult.ok) {
        throw httpError('INVALID_PHONE', {
          detail: phoneResult.error.message,
          fields: { input: body.owner.phone },
        });
      }
      const phoneE164 = phoneResult.value;

      const orgStore = getAggregatorOrgStore();
      const idp = getIdpAdmin();
      const ownerEmail = body.owner.email.toLowerCase();

      // §7 reclaim: a resubmit by the same owner against a still-recoverable
      // org (pending, or rejected == inactive) refreshes that row and re-mints
      // the network-admin review link, instead of erroring on the existing KC
      // owner user. An *active* org for this owner is a genuine duplicate.
      const existing = await orgStore.findByOwnerEmail(ownerEmail);
      if (!existing.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(existing.error.message),
          fields: { sub_operation: 'orgStore.findByOwnerEmail' },
        });
      }
      if (existing.value) {
        const prior = existing.value;
        if (prior.status === 'active') {
          throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: body.owner.email } });
        }
        // Reclaim: refresh submitted details + flip back to pending. The
        // mirrored KC group + disabled owner user are reused in place.
        const refreshed = await orgStore.update(prior.id, {
          displayName: body.display_name,
          state: body.state ?? null,
          ownerPhone: phoneE164,
          status: 'pending',
        });
        if (!refreshed.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(refreshed.error.message),
            fields: { sub_operation: 'orgStore.update.reclaim' },
          });
        }
        await sendOrgReviewEmail(
          {
            orgId: prior.id,
            displayName: body.display_name,
            ownerEmail: prior.ownerEmail,
            ownerPhone: phoneE164,
          },
          log,
        );
        log.info(
          { status: 'success', latency_ms: Date.now() - start, org_id: prior.id, reclaim: true },
          'org registration resubmitted (reclaimed record)',
        );
        return reply.status(200).send({
          org_id: prior.id,
          slug: prior.slug,
          status: 'pending',
          message: 'Organisation re-submitted. A fresh approval link has been sent for review.',
        });
      }

      const slug = slugFromName(body.display_name);
      const created = await orgStore.create({
        slug,
        displayName: body.display_name,
        state: body.state ?? null,
        ownerEmail: ownerEmail,
        ownerPhone: phoneE164,
      });
      if (!created.ok) {
        if (created.error.code === 'DUPLICATE_SLUG') {
          throw httpError('ORG_SLUG_TAKEN', { fields: { slug } });
        }
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(created.error.message),
          fields: { sub_operation: 'orgStore.create' },
        });
      }
      const org = created.value;

      // Mirrored KC group (authz mirror — spec §9). Roll the org back to
      // inactive on failure so a half-provisioned org never appears active.
      // The group name is slug-based (unique + stable); the human org name is
      // carried as a `display_name` attribute so it is visible in Keycloak.
      const group = await idp.createGroup(`org-${slug}`, {
        org_id: org.id,
        display_name: body.display_name,
      });
      if (!group.ok) {
        await orgStore.update(org.id, { status: 'inactive' });
        throw httpError('IDP_UNAVAILABLE', {
          cause: new Error(group.error.message),
          fields: { sub_operation: 'idp.createGroup', rolled_back: true },
        });
      }

      // Disabled org-owner KC user (enabled at approval — spec §9 / A8).
      const { firstName, lastName } = splitName(body.owner.name);
      const ownerUser = await idp.createUser({
        email: body.owner.email,
        username: body.owner.email,
        phone: phoneE164,
        enabled: false,
        firstName,
        lastName,
        attributes: {
          [KC_ATTR.PHONE_NUMBER]: phoneE164,
          [KC_ATTR.DECISION_MADE]: 'pending',
        },
      });
      if (!ownerUser.ok) {
        await orgStore.update(org.id, { status: 'inactive' });
        if (ownerUser.error.code === 'USER_EXISTS') {
          throw httpError('OWNER_ALREADY_REGISTERED', {
            fields: { email: body.owner.email, rolled_back: true },
          });
        }
        throw httpError('IDP_UNAVAILABLE', {
          cause: new Error(ownerUser.error.message),
          fields: { sub_operation: 'idp.createUser', rolled_back: true },
        });
      }

      const stamped = await orgStore.update(org.id, {
        kcGroupId: group.value.id,
        ownerKcSub: ownerUser.value.id,
      });
      if (!stamped.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(stamped.error.message),
          fields: { sub_operation: 'orgStore.update.stamp' },
        });
      }

      await sendOrgReviewEmail(
        {
          orgId: org.id,
          displayName: body.display_name,
          ownerEmail: body.owner.email,
          ownerPhone: phoneE164,
        },
        log,
      );

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          org_id: org.id,
          slug,
          kc_group_id: group.value.id,
        },
        'org registration submitted',
      );

      return reply.status(201).send({
        org_id: org.id,
        slug,
        status: 'pending',
        message: 'Organisation submitted. A reviewer will approve it before coordinators can join.',
      });
    },
  );

  app.get(
    '/v1/orgs',
    {
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'List active orgs for the coordinator-registration dropdown',
        description:
          'Returns active orgs only (plain SQL, no Keycloak admin API). Only registered when ORG_HIERARCHY_ENABLED=true.',
        response: { 200: OrgListResponseSchema, ...errorResponses(401, 500, 503) },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = await authenticateAny(req);
      if (!auth.ok) {
        throw httpError('UNAUTHORIZED', {
          detail: auth.error.message,
          fields: { reason: auth.error.code },
        });
      }
      const page = await getAggregatorOrgStore().listActive();
      if (!page.ok) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(page.error.message),
          fields: { sub_operation: 'orgStore.listActive' },
        });
      }
      return reply.status(200).send({
        orgs: page.value.map((o) => ({ id: o.id, slug: o.slug, display_name: o.displayName })),
      });
    },
  );
}

/**
 * Splits a single-line contact name into Keycloak's first / last fields.
 * Everything before the first whitespace is the first name; the remainder is
 * the last name. Single-token inputs produce an empty last name.
 *
 * @param fullName - The owner's full name from the form.
 * @returns First and last name parts.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const firstSpace = trimmed.search(/\s+/);
  if (firstSpace === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, firstSpace),
    lastName: trimmed.slice(firstSpace).trim(),
  };
}
