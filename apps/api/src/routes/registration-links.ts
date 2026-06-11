/**
 * Registration links endpoints.
 *
 *   POST /v1/links/create              create a link + QR
 *   GET  /v1/links                     list links scoped to aggregator
 *   GET  /v1/links/:id                 read a single link with QR URL
 *   POST /v1/links/:id/activate        flip a draft link to live (idempotent)
 *   POST /v1/links/:id/deactivate      retire a link (idempotent)
 *
 * All endpoints require an authenticated aggregator JWT and scope writes by
 * `aggregator_id` claim — cross-aggregator access is impossible by construction.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireApproved, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { putObject, signQrDownloadUrl } from '../services/object-storage/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { onboarding } from '../db/schema.js';
import { getNetworkConfig } from '../services/network-config.js';

interface LinkMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

const ZERO_METRICS: LinkMetrics = { total: 0, passed: 0, failed: 0, skipped: 0 };

/**
 * Sums the rolled-up `onboarding` rows (source='link') for one or more link
 * IDs scoped to a single aggregator. Returns a Map keyed by link_id; missing
 * keys mean the link has no rolled-up submissions yet.
 */
async function fetchLinkMetrics(
  aggregatorId: string,
  linkIds: string[],
): Promise<Map<string, LinkMetrics>> {
  const out = new Map<string, LinkMetrics>();
  if (linkIds.length === 0) return out;
  const rows = await getDb()
    .select({
      linkId: onboarding.linkId,
      total: sql<number>`coalesce(sum(${onboarding.total}), 0)::int`,
      passed: sql<number>`coalesce(sum(${onboarding.passed}), 0)::int`,
      failed: sql<number>`coalesce(sum(${onboarding.failed}), 0)::int`,
      skipped: sql<number>`coalesce(sum(${onboarding.skipped}), 0)::int`,
    })
    .from(onboarding)
    .where(
      and(
        eq(onboarding.aggregatorId, aggregatorId),
        eq(onboarding.source, 'link'),
        inArray(onboarding.linkId, linkIds),
      ),
    )
    .groupBy(onboarding.linkId);
  for (const r of rows) {
    if (!r.linkId) continue;
    out.set(r.linkId, {
      total: r.total ?? 0,
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      skipped: r.skipped ?? 0,
    });
  }
  return out;
}

const CreateLinkBodySchema = z.object({
  domain: z.string().min(1),
  /**
   * Optional client-supplied slug. URL-safe lowercase, hyphen-separated,
   * 3-60 chars. The route appends a short random suffix on collision so the
   * caller doesn't have to retry — the returned `public_url` carries the
   * final allocated slug.
   */
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
    .min(3)
    .max(60)
    .optional(),
  context: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'live']).default('draft'),
  /**
   * Per-link admin-facing registration mode key (e.g. `voice`, `form`). The
   * mode → form-shape mapping lives in network config under
   * `registration_modes`; the key is validated against the live config in the
   * handler. Omitted defaults to the network's `form` mode. Open snake_case
   * identifier. Immutable after creation (PATCH route .strict()-rejects it).
   */
  registration_mode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((v) => (v ? new Date(v) : null)),
});

/**
 * Patch shape for `PATCH /v1/links/:id`. Only fields editable on a draft are
 * accepted; `domain` + `status` mutations go through dedicated endpoints
 * (signup-time pin and activate/deactivate respectively).
 */
const UpdateLinkBodySchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase + hyphens (a-z, 0-9)')
      .min(3)
      .max(60)
      .optional(),
    context: z.record(z.unknown()).optional(),
    expires_at: z
      .string()
      .datetime({ offset: true })
      .nullish()
      .transform((v) => (v === undefined ? undefined : v === null ? null : new Date(v))),
  })
  .strict();

const SLUG_RETRIES = 5;

const ListQuerySchema = z.object({
  status: z.enum(['draft', 'live', 'retired']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Wire-format variant of {@link CreateLinkBodySchema} for the route's OpenAPI
 * `body` block. Identical shape minus the `expires_at` string→Date transform:
 * fastify mutates `req.body` with the parsed output, and a transformed Date
 * would make the handler's own `safeParse` (which expects the wire string)
 * fail. Keep both schemas' fields in sync.
 */
const CreateLinkOpenApiBodySchema = CreateLinkBodySchema.extend({
  expires_at: z.string().datetime({ offset: true }).nullish(),
});

/** Wire-format variant of {@link UpdateLinkBodySchema} — see note above. */
const UpdateLinkOpenApiBodySchema = UpdateLinkBodySchema.extend({
  expires_at: z.string().datetime({ offset: true }).nullish(),
});

/** Path params for routes addressing a single registration link. */
const LinkParamsSchema = z.object({
  id: z.string().min(1).describe('Registration link id (UUID).'),
});

/** Canonical wire shape of a registration link (see {@link buildResponse}). */
const LinkResponseSchema = z
  .object({
    link_id: z.string(),
    slug: z.string(),
    domain: z.string(),
    status: z.string(),
    registration_mode: z.string(),
    context: z.record(z.unknown()),
    expires_at: z.string().nullable(),
    public_url: z.string().nullable(),
    qr_url: z.string().nullable(),
    qr_expires_at: z.string().nullable(),
    metrics: z
      .object({
        total: z.number(),
        passed: z.number(),
        failed: z.number(),
        skipped: z.number(),
      })
      .passthrough(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

/** 200 payload for the paginated links list. */
const ListLinksResponseSchema = z
  .object({
    items: z.array(LinkResponseSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .passthrough();

export async function registerRegistrationLinksRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/links/create',
    {
      schema: {
        tags: ['registration-links'],
        summary: 'Create a shareable registration link',
        description:
          'Creates a QR / shareable registration link for the caller aggregator, scoped to a domain (seeker/provider). `domain` and `registration_mode` are validated against the active network config at request time. Drafts are metadata-only; status=live also mints the QR + public URL.',
        body: CreateLinkOpenApiBodySchema,
        response: {
          201: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({
        operation: 'registrationLinks.create',
        actor: auth.userId,
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      const parsed = CreateLinkBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Request body failed shape validation.',
          fields: { issues: parsed.error.issues },
        });
      }
      const body = parsed.data;
      const networkCfg = await getNetworkConfig();
      if (!networkCfg.domainIds.includes(body.domain)) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: `unknown domain '${body.domain}' — valid: ${networkCfg.domainIds.join(', ')}`,
          fields: { domain: 'invalid' },
        });
      }
      enforceAggregatorType(auth, body.domain);

      const declaredModes = Object.keys(networkCfg.aggregator.registration_modes ?? {});
      // Omitted mode preserves the legacy full-profile default: prefer the
      // `form` key (DB column default) when the network declares it, else the
      // first declared mode. Never silently downgrade an omitted link to an
      // account_only channel.
      const modeKey =
        body.registration_mode ??
        (declaredModes.includes('form') ? 'form' : declaredModes[0]) ??
        'form';
      if (!declaredModes.includes(modeKey)) {
        throw httpError('INVALID_REGISTRATION_MODE', {
          detail: `registration_mode '${modeKey}' is not declared for this network`,
          fields: { declared: declaredModes },
        });
      }
      const store = getRegistrationLinksStore();

      // Slug allocation. If the caller supplied a slug, try it first; collisions
      // are resolved by appending a short random suffix (`-XXXX`) so the user
      // keeps the readable part of their slug. Without a caller-supplied slug,
      // a pure-random base62 stem is used.
      let created;
      let slug = '';
      for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
        if (body.slug) {
          slug = attempt === 0 ? body.slug : `${body.slug}-${randomSuffix()}`;
        } else {
          slug = generateSlug();
        }
        const result = await store.create({
          aggregatorId: auth.aggregatorId,
          slug,
          domain: body.domain,
          context: body.context,
          status: body.status,
          registrationMode: modeKey,
          expiresAt: body.expires_at,
          createdBy: auth.userId,
        });
        if (result.ok) {
          created = result.value;
          break;
        }
        if (result.error.code !== 'SLUG_COLLISION') {
          log.error({
            status: 'failure',
            sub: 'store.create',
            error: result.error.code,
            latency_ms: Date.now() - start,
          });
          throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
        }
        log.warn({ status: 'retry', reason: 'slug_collision', attempt, slug });
      }
      if (!created) {
        log.error({
          status: 'failure',
          reason: 'slug_retries_exhausted',
          latency_ms: Date.now() - start,
        });
        throw httpError('DUPLICATE_SLUG', {
          detail: 'Could not allocate a unique slug for the link. Please retry.',
        });
      }

      // Aggregator org_slug for the URL namespace. Cached per-create only —
      // worst-case one extra row read per link, which is negligible vs the
      // alternative of denormalising org_slug onto every registration_links row.
      const aggregatorStore = getAggregatorStore();
      const aggLookup = await aggregatorStore.findById(auth.aggregatorId);
      if (!aggLookup.ok || !aggLookup.value) {
        throw httpError('DB_UNAVAILABLE', {
          cause: new Error(
            aggLookup.ok ? 'aggregator row missing for caller' : aggLookup.error.message,
          ),
        });
      }
      const callerOrgSlug = aggLookup.value.orgSlug;

      // QR + public URL are only minted when the link is published (status=live).
      // Drafts are pure metadata — the slug may still change via PATCH, so
      // generating a QR now would waste S3 work and risk publishing a stale
      // image. Activation runs the QR pipeline.
      if (created.status === 'draft') {
        log.info({
          status: 'success',
          latency_ms: Date.now() - start,
          link_id: created.id,
          slug: created.slug,
          domain: created.domain,
          qr_object_key: null,
          link_status: 'draft',
        });
        return reply.code(201).send(await buildResponse(created, callerOrgSlug));
      }

      // status === 'live' — eager activate-at-create path. Generate the QR
      // PNG, upload to S3 keyed deterministically, then stamp qr_object_key.
      const publicUrl = buildPublicUrl(callerOrgSlug, slug);
      const qrKey = `qr/${auth.aggregatorId}/${created.id}.png`;
      let qrPng: Buffer;
      try {
        qrPng = await QRCode.toBuffer(publicUrl, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 512,
        });
      } catch (err) {
        log.error({ status: 'failure', sub: 'qr.generate', error: (err as Error).message });
        throw httpError('INTERNAL', { cause: err });
      }
      try {
        await putObject(qrKey, qrPng, 'image/png');
      } catch (err) {
        log.error({ status: 'failure', sub: 's3.put', error: (err as Error).message });
        throw httpError('INTERNAL', { cause: err });
      }

      const updated = await store.updateQrKey(created.id, auth.aggregatorId, qrKey);
      if (!updated.ok) {
        log.error({
          status: 'failure',
          sub: 'store.updateQrKey',
          error: updated.error.code,
        });
        throw httpError('DB_UNAVAILABLE', { cause: new Error(updated.error.message) });
      }

      const qrSigned = await signQrDownloadUrl(qrKey);

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        link_id: updated.value.id,
        slug: updated.value.slug,
        domain: updated.value.domain,
        qr_object_key: qrKey,
      });

      return reply.code(201).send(
        await buildResponse(updated.value, callerOrgSlug, {
          publicUrl,
          qrSigned: { url: qrSigned.url, expiresAt: qrSigned.expiresAt },
        }),
      );
    },
  );

  app.get(
    '/v1/links',
    {
      schema: {
        tags: ['registration-links'],
        summary: "List the caller aggregator's registration links",
        description: 'Paginated list (newest first) of registration links with status + counters.',
        querystring: ListQuerySchema,
        response: {
          200: ListLinksResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const log = req.log.child({
        operation: 'registrationLinks.list',
        actor: auth.userId,
        aggregator_id: auth.aggregatorId,
      });
      const start = Date.now();

      const parsed = ListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Query parameters failed validation.',
          fields: { issues: parsed.error.issues },
        });
      }
      const { status, limit, offset } = parsed.data;

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      const result = await getRegistrationLinksStore().list(auth.aggregatorId, {
        ...(status ? { status } : {}),
        limit,
        offset,
      });
      if (!result.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
      }

      // Single grouped SQL for all link metrics; per-row fallback in
      // buildResponse would N+1 the list endpoint.
      const metricsById = await fetchLinkMetrics(
        auth.aggregatorId,
        result.value.rows.map((r) => r.id),
      );
      const items = await Promise.all(
        result.value.rows.map((row) =>
          buildResponse(row, orgSlug, { metrics: metricsById.get(row.id) ?? ZERO_METRICS }),
        ),
      );

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        total: result.value.total,
        returned: items.length,
      });

      return reply.send({
        items,
        total: result.value.total,
        limit,
        offset,
      });
    },
  );

  app.patch(
    '/v1/links/:id',
    {
      schema: {
        tags: ['registration-links'],
        summary: 'Update a registration link',
        description:
          'Partial update of mutable draft-link fields (slug, context, expiry). Only draft links can be edited; `registration_mode` and `domain` are immutable and unknown keys are rejected with 400.',
        params: LinkParamsSchema,
        body: UpdateLinkOpenApiBodySchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 409, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const params = req.params as { id?: string };
      const linkId = params.id;
      if (!linkId) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'link_id is required.' });
      }
      const log = req.log.child({
        operation: 'registrationLinks.update',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const parsed = UpdateLinkBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Request body failed shape validation.',
          fields: { issues: parsed.error.issues },
        });
      }
      const body = parsed.data;

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }
      if (found.value.status !== 'draft') {
        throw httpError('CONFLICT', {
          detail: 'Only draft links can be edited. Retire this link and create a new one.',
          fields: { link_status: found.value.status },
        });
      }

      // Slug-collision retry — mirror create flow. If the caller asks to set a
      // slug that's already taken by a sibling link, append a short random
      // suffix and try again. Without a caller-supplied slug, leave the
      // existing slug in place (omit `slug` from the patch).
      let updated;
      let slug = found.value.slug;
      if (body.slug !== undefined) {
        for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
          slug = attempt === 0 ? body.slug : `${body.slug}-${randomSuffix()}`;
          const result = await store.updateDraft(linkId, auth.aggregatorId, {
            slug,
            ...(body.context !== undefined ? { context: body.context } : {}),
            ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
          });
          if (result.ok) {
            updated = result.value;
            break;
          }
          if (result.error.code !== 'SLUG_COLLISION') {
            if (result.error.code === 'NOT_FOUND') {
              throw httpError('CONFLICT', {
                detail: 'Link is no longer a draft — edit blocked.',
              });
            }
            log.error({
              status: 'failure',
              sub: 'store.updateDraft',
              error: result.error.code,
              latency_ms: Date.now() - start,
            });
            throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
          }
          log.warn({ status: 'retry', reason: 'slug_collision', attempt, slug });
        }
        if (!updated) {
          log.error({
            status: 'failure',
            reason: 'slug_retries_exhausted',
            latency_ms: Date.now() - start,
          });
          throw httpError('DUPLICATE_SLUG', {
            detail: 'Could not allocate a unique slug for the link. Please retry.',
          });
        }
      } else {
        const result = await store.updateDraft(linkId, auth.aggregatorId, {
          ...(body.context !== undefined ? { context: body.context } : {}),
          ...(body.expires_at !== undefined ? { expiresAt: body.expires_at } : {}),
        });
        if (!result.ok) {
          if (result.error.code === 'NOT_FOUND') {
            throw httpError('CONFLICT', {
              detail: 'Link is no longer a draft — edit blocked.',
            });
          }
          throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
        }
        updated = result.value;
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        slug: updated.slug,
        slug_changed: body.slug !== undefined,
      });
      return reply.send(await buildResponse(updated, orgSlug));
    },
  );

  app.get(
    '/v1/links/:id',
    {
      schema: {
        tags: ['registration-links'],
        summary: 'Read a registration link',
        description: 'Full link row including counters + status.',
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const params = req.params as { id?: string };
      const linkId = params.id;
      if (!linkId) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'link_id is required.' });
      }

      const result = await getRegistrationLinksStore().findById(linkId, auth.aggregatorId);
      if (!result.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
      }
      if (!result.value) {
        // 403 to prevent cross-aggregator enumeration.
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }
      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      return reply.send(await buildResponse(result.value, orgSlug));
    },
  );

  app.post(
    '/v1/links/:id/activate',
    {
      schema: {
        tags: ['registration-links'],
        summary: 'Activate a registration link',
        description:
          'Flips the link status to live so the public form accepts submissions; mints the QR PNG + public URL. Idempotent when already live; retired links cannot be reactivated (409).',
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const params = req.params as { id?: string };
      const linkId = params.id;
      if (!linkId) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'link_id is required.' });
      }
      const log = req.log.child({
        operation: 'registrationLinks.activate',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      if (found.value.status === 'live') {
        log.info({ status: 'skipped', reason: 'already_live', latency_ms: Date.now() - start });
        return reply.send(await buildResponse(found.value, orgSlug));
      }
      if (found.value.status === 'retired') {
        throw httpError('CONFLICT', { detail: 'Retired links cannot be reactivated.' });
      }

      // Mint the QR PNG at activation time — the draft slug is now frozen and
      // the public URL it encodes will not change. If a qr_object_key already
      // exists (e.g. legacy row from when drafts also got QRs) we reuse the key
      // and overwrite the bytes; the key is deterministic.
      const publicUrl = buildPublicUrl(orgSlug, found.value.slug);
      const qrKey = found.value.qrObjectKey ?? `qr/${auth.aggregatorId}/${found.value.id}.png`;
      let qrPng: Buffer;
      try {
        qrPng = await QRCode.toBuffer(publicUrl, {
          type: 'png',
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 512,
        });
      } catch (err) {
        log.error({ status: 'failure', sub: 'qr.generate', error: (err as Error).message });
        throw httpError('INTERNAL', { cause: err });
      }
      try {
        await putObject(qrKey, qrPng, 'image/png');
      } catch (err) {
        log.error({ status: 'failure', sub: 's3.put', error: (err as Error).message });
        throw httpError('INTERNAL', { cause: err });
      }

      const qrStamped = await store.updateQrKey(linkId, auth.aggregatorId, qrKey);
      if (!qrStamped.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(qrStamped.error.message) });
      }

      const updated = await store.updateStatus(linkId, auth.aggregatorId, 'live');
      if (!updated.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(updated.error.message) });
      }

      const qrSigned = await signQrDownloadUrl(qrKey);

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        previous_status: found.value.status,
        qr_object_key: qrKey,
      });

      return reply.send(
        await buildResponse(updated.value, orgSlug, {
          publicUrl,
          qrSigned: { url: qrSigned.url, expiresAt: qrSigned.expiresAt },
        }),
      );
    },
  );

  app.post(
    '/v1/links/:id/deactivate',
    {
      schema: {
        tags: ['registration-links'],
        summary: 'Deactivate a registration link',
        description:
          'Flips status to retired — the public form returns 410 for further submissions. Idempotent when already retired.',
        params: LinkParamsSchema,
        response: {
          200: LinkResponseSchema,
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);
      const params = req.params as { id?: string };
      const linkId = params.id;
      if (!linkId) {
        throw httpError('SCHEMA_VALIDATION', { detail: 'link_id is required.' });
      }
      const log = req.log.child({
        operation: 'registrationLinks.deactivate',
        actor: auth.userId,
        link_id: linkId,
      });
      const start = Date.now();

      const store = getRegistrationLinksStore();
      const found = await store.findById(linkId, auth.aggregatorId);
      if (!found.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
      }
      if (!found.value) {
        throw httpError('FORBIDDEN', { detail: 'Link not accessible.' });
      }

      const orgSlug = await resolveOrgSlug(auth.aggregatorId);
      if (found.value.status === 'retired') {
        log.info({ status: 'skipped', reason: 'already_retired', latency_ms: Date.now() - start });
        return reply.send(await buildResponse(found.value, orgSlug));
      }

      const updated = await store.updateStatus(linkId, auth.aggregatorId, 'retired');
      if (!updated.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(updated.error.message) });
      }

      log.info({
        status: 'success',
        latency_ms: Date.now() - start,
        previous_status: found.value.status,
      });

      return reply.send(await buildResponse(updated.value, orgSlug));
    },
  );
}

/**
 * Resolves the caller's aggregator org_slug. Used by the public-URL builder
 * which needs the slug as a path segment. Wrapped in a helper so handlers
 * don't repeat the lookup-or-throw boilerplate.
 */
async function resolveOrgSlug(aggregatorId: string): Promise<string> {
  const result = await getAggregatorStore().findById(aggregatorId);
  if (!result.ok || !result.value) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(result.ok ? 'aggregator row missing for caller' : result.error.message),
    });
  }
  return result.value.orgSlug;
}

interface ResponseOverrides {
  publicUrl?: string;
  qrSigned?: { url: string; expiresAt: string };
  metrics?: LinkMetrics;
}

/**
 * Renders a registration link as the canonical API response shape. Lazily
 * presigns the QR URL when the row has a stored qr_object_key — keeps list
 * responses fresh without persisting short-lived URLs.
 *
 * @param orgSlug - The owning aggregator's `org_slug`. The public URL is
 *   namespaced under it (`<base>/<org_slug>/<link_slug>`), so we need it to
 *   re-mint the URL each request rather than persisting a stale snapshot.
 */
async function buildResponse(
  row: RegistrationLink,
  orgSlug: string,
  overrides: ResponseOverrides = {},
): Promise<Record<string, unknown>> {
  // Drafts are metadata-only — the QR + public URL are minted at activation
  // and never published while the row is still in draft. Retired links lose
  // visibility of the QR for the same reason: the underlying poster is no
  // longer authoritative.
  const isPublished = row.status === 'live';
  const publicUrl = isPublished ? (overrides.publicUrl ?? buildPublicUrl(orgSlug, row.slug)) : null;
  let qrUrl: string | null = null;
  let qrExpiresAt: string | null = null;
  if (isPublished) {
    if (overrides.qrSigned) {
      qrUrl = overrides.qrSigned.url;
      qrExpiresAt = overrides.qrSigned.expiresAt;
    } else if (row.qrObjectKey) {
      const signed = await signQrDownloadUrl(row.qrObjectKey);
      qrUrl = signed.url;
      qrExpiresAt = signed.expiresAt;
    }
  }
  // `metrics` may be supplied by the caller when responding to a list (one
  // grouped SQL aggregation per request); otherwise fall back to a per-link
  // lookup so single-link reads still surface counters.
  const metrics =
    overrides.metrics ??
    (await fetchLinkMetrics(row.aggregatorId, [row.id])).get(row.id) ??
    ZERO_METRICS;
  return {
    link_id: row.id,
    slug: row.slug,
    domain: row.domain,
    status: row.status,
    registration_mode: row.registrationMode,
    context: row.context,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    public_url: publicUrl,
    qr_url: qrUrl,
    qr_expires_at: qrExpiresAt,
    metrics,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Generates a URL-safe random slug. 8 random bytes → 16 hex chars; collisions
 * across a single aggregator are vanishingly unlikely but the route still
 * retries on the unique-violation error from the store as defence in depth.
 */
function randomSuffix(bytes = 2): string {
  return randomBytes(bytes).toString('hex');
}

function generateSlug(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Build the public URL for a registration link. The URL is namespaced under
 * the aggregator's `org_slug` so two aggregators can use the same per-link
 * slug without collision: `${base}/<org_slug>/<slug>`.
 */
function buildPublicUrl(orgSlug: string, slug: string): string {
  const base = config.PUBLIC_LINK_BASE_URL.replace(/\/+$/, '');
  return `${base}/${orgSlug}/${slug}`;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await requireApproved(req);
  if (!result.ok) {
    if (result.error.code === 'NOT_APPROVED') {
      throw httpError('NOT_APPROVED', { detail: result.error.message });
    }
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}

/**
 * Reject when the requested link domain (seeker | provider) does not match
 * the aggregator's registered type (JWT `aggregator_type` claim). An
 * aggregator may only create registration links for the type it registered as.
 */
function enforceAggregatorType(auth: AuthContext, domain: string): void {
  if (!auth.aggregatorType) {
    throw httpError('AGGREGATOR_TYPE_MISSING', {
      fields: { aggregator_id: auth.aggregatorId },
    });
  }
  if (auth.aggregatorType !== domain) {
    throw httpError('AGGREGATOR_TYPE_MISMATCH', {
      fields: {
        aggregator_type: auth.aggregatorType,
        requested_type: domain,
      },
    });
  }
}
