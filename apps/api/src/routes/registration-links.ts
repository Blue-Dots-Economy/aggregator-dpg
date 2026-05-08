/**
 * Registration links endpoints.
 *
 *   POST /v1/links/create
 *     Create a registration link for the calling aggregator. Generates a
 *     unique slug, persists the row, renders a QR PNG pointing at
 *     `${PUBLIC_LINK_BASE_URL}/${slug}`, uploads the PNG to S3 at a
 *     deterministic key, and returns a presigned QR download URL.
 *
 * Subsequent slices add list/read/deactivate (slice 15) and the public
 * resolve / submit endpoints (slices 16-17).
 *
 * All endpoints require an authenticated aggregator JWT and scope writes by
 * `aggregator_id` claim — cross-aggregator access is impossible by construction.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import { putObject, signQrDownloadUrl } from '../services/object-storage/index.js';
import { httpError } from '../errors/http-error.js';
import { config } from '../config.js';

const CreateLinkBodySchema = z.object({
  domain: z.enum(['seeker', 'provider']),
  context: z.record(z.unknown()).default({}),
  status: z.enum(['draft', 'live']).default('draft'),
  expires_at: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((v) => (v ? new Date(v) : null)),
});

const SLUG_RETRIES = 5;

export async function registerRegistrationLinksRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/links/create', async (req, reply) => {
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

    const store = getRegistrationLinksStore();

    // Slug allocation with bounded retry. Slug is not user-facing input, so a
    // pure-random base62 stem keeps URLs short and dodges most collisions.
    let created;
    let slug = '';
    for (let attempt = 0; attempt < SLUG_RETRIES; attempt++) {
      slug = generateSlug();
      const result = await store.create({
        aggregatorId: auth.aggregatorId,
        slug,
        domain: body.domain,
        context: body.context,
        status: body.status,
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

    // QR generation + S3 upload. Keyed deterministically so a re-run after a
    // partial failure overwrites identical bytes.
    const publicUrl = buildPublicUrl(slug);
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

    return reply.code(201).send({
      link_id: updated.value.id,
      slug: updated.value.slug,
      domain: updated.value.domain,
      status: updated.value.status,
      context: updated.value.context,
      expires_at: updated.value.expiresAt ? updated.value.expiresAt.toISOString() : null,
      public_url: publicUrl,
      qr_url: qrSigned.url,
      qr_expires_at: qrSigned.expiresAt,
      created_at: updated.value.createdAt.toISOString(),
    });
  });
}

/**
 * Generates a URL-safe random slug. 8 random bytes → 16 hex chars; collisions
 * across a single aggregator are vanishingly unlikely but the route still
 * retries on the unique-violation error from the store as defence in depth.
 */
function generateSlug(): string {
  return randomBytes(8).toString('hex');
}

function buildPublicUrl(slug: string): string {
  const base = config.PUBLIC_LINK_BASE_URL.replace(/\/+$/, '');
  return `${base}/${slug}`;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (!result.ok) {
    throw httpError('UNAUTHORIZED', { detail: result.error.message });
  }
  if (!result.context.aggregatorId) {
    throw httpError('UNAUTHORIZED', { detail: 'Token missing aggregator_id claim.' });
  }
  return result.context;
}
