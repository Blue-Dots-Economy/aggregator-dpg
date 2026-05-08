/**
 * Public registration link endpoints.
 *
 *   GET  /public/v1/links/resolve/:slug
 *     Anonymous resolve. Returns the public-safe shape of a live link so a
 *     BFF can render the registration form. 404 for missing or draft slugs;
 *     410 for retired or expired ones.
 *
 *   POST /public/v1/registrations/create/:slug
 *     Anonymous synchronous submit. Validates the body against the active
 *     participant schema for the link's domain, normalises phone+email,
 *     creates the participant + a link_submission row, and returns the
 *     submission id. Implemented in slice 17 alongside slice 16 because
 *     they share the slug resolution + status guards.
 *
 * Security model: slug is the access token. No JWT required. Aggregator
 * scoping is implicit via the link row.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { normalisePhone } from '../services/phone.js';
import { getDb } from '../db/client.js';
import { participants, linkSubmissions } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';

interface SlugParams {
  slug?: string;
}

export async function registerPublicRegistrationLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public/v1/links/resolve/:slug', async (req, reply) => {
    const slug = (req.params as SlugParams).slug;
    if (!slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'slug is required.' });
    }
    const log = req.log.child({ operation: 'public.linkResolve', slug });
    const start = Date.now();

    const link = await loadLiveLinkBySlug(slug, log);

    log.info({
      status: 'success',
      latency_ms: Date.now() - start,
      link_id: link.id,
      domain: link.domain,
    });

    return reply.send({
      slug: link.slug,
      domain: link.domain,
      context: link.context,
      schema_id: `participant-${link.domain}`,
      schema_version: 'v1',
      expires_at: link.expiresAt ? link.expiresAt.toISOString() : null,
    });
  });

  app.post('/public/v1/registrations/create/:slug', async (req, reply) => {
    const slug = (req.params as SlugParams).slug;
    if (!slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'slug is required.' });
    }
    const log = req.log.child({ operation: 'public.registrationSubmit', slug });
    const start = Date.now();

    // Rate limit by (slug, ip). CAPTCHA enforcement is handled at the BFF
    // layer (Cloudflare Turnstile) — the API layer keeps a coarse fallback
    // so a misconfigured BFF can't expose unbounded write traffic.
    const ip = (req.ip ?? '0.0.0.0').toString();
    const rate = await consume({
      namespace: 'link-submit',
      key: `${slug}:${ip}`,
      windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
      max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
    });
    if (!rate.allowed) {
      void reply.header('Retry-After', String(rate.retryAfterSeconds));
      log.warn({ status: 'rate_limited', count: rate.count, ip });
      throw httpError('RATE_LIMITED', {
        detail: `Retry in ${rate.retryAfterSeconds}s.`,
      });
    }

    const link = await loadLiveLinkBySlug(slug, log);

    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Schema validation against the link's domain schema.
    const schemaRef = { id: `participant-${link.domain}`, version: 'v1' };
    const validatorResult = await getSchemaLoader().getValidator(schemaRef);
    if (!validatorResult.success) {
      log.error({ status: 'failure', sub: 'schema.load', error: validatorResult.error.code });
      throw httpError('INTERNAL', {
        detail: 'Registration schema unavailable.',
        cause: new Error(validatorResult.error.message),
      });
    }
    const validate = validatorResult.value;
    if (!validate(body)) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'Submission failed schema validation.',
        fields: { issues: validate.errors ?? [] },
      });
    }

    // 2. Normalisation.
    const participantId = String(body['participant_id'] ?? '').trim();
    if (!participantId) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'participant_id is required.',
        fields: { participant_id: 'required' },
      });
    }
    const phoneRaw = typeof body['phone'] === 'string' ? (body['phone'] as string) : '';
    let phoneNormalised: string | null = null;
    if (phoneRaw) {
      const phone = normalisePhone(phoneRaw);
      if (!phone.ok) {
        throw httpError('INVALID_PHONE', { detail: phone.error.message });
      }
      phoneNormalised = phone.value;
    }
    const emailRaw = typeof body['email'] === 'string' ? (body['email'] as string) : '';
    const emailNormalised = emailRaw ? emailRaw.trim().toLowerCase() : null;

    // 3 + 4. participant INSERT (ON CONFLICT DO NOTHING) and link_submission
    // INSERT must commit atomically — otherwise a crash between them leaves a
    // participant without a corresponding submission row, and the metrics
    // rollup never credits the registration.
    const txResult = await getDb().transaction(async (tx) => {
      const inserted = await tx
        .insert(participants)
        .values({
          aggregatorId: link.aggregatorId,
          type: link.domain,
          participantId,
          data: body,
          phone: phoneNormalised,
          email: emailNormalised,
          sourceLinkId: link.id,
        })
        .onConflictDoNothing({
          target: [participants.aggregatorId, participants.participantId],
        })
        .returning({ id: participants.id });

      let outcome: 'passed' | 'skipped';
      let participantRowId: string | null = null;
      if (inserted.length > 0 && inserted[0]) {
        outcome = 'passed';
        participantRowId = inserted[0].id;
      } else {
        const existing = await tx
          .select({ id: participants.id })
          .from(participants)
          .where(
            and(
              eq(participants.aggregatorId, link.aggregatorId),
              eq(participants.participantId, participantId),
            ),
          )
          .limit(1);
        participantRowId = existing[0]?.id ?? null;
        outcome = 'skipped';
      }

      const submission = await tx
        .insert(linkSubmissions)
        .values({
          linkId: link.id,
          aggregatorId: link.aggregatorId,
          participantId: participantRowId,
          metadataSnapshot: link.context,
          submittedData: body,
          outcome,
        })
        .returning({ id: linkSubmissions.id });

      return {
        outcome,
        participantRowId,
        submissionId: submission[0]?.id,
      };
    });
    const { outcome, participantRowId, submissionId } = txResult;

    log.info({
      status: 'success',
      event_type: 'audit',
      audit: 'link.submission_recorded',
      latency_ms: Date.now() - start,
      link_id: link.id,
      outcome,
      participant_id: participantRowId,
      submission_id: submissionId,
    });

    if (outcome === 'skipped') {
      // Surface dedup in the response status to match the design (409).
      return reply.code(409).send({
        outcome,
        submission_id: submissionId,
        participant_id: participantRowId,
        message: 'Already registered with this aggregator.',
      });
    }

    return reply.code(201).send({
      outcome,
      submission_id: submissionId,
      participant_id: participantRowId,
    });
  });
}

/**
 * Loads a registration link by slug and asserts it is currently `live`.
 * Translates store/null/expiry into the canonical 404 / 410 status codes.
 */
async function loadLiveLinkBySlug(
  slug: string,
  log: FastifyRequest['log'],
): Promise<RegistrationLink> {
  const store = getRegistrationLinksStore();
  const found = await store.findBySlug(slug);
  if (!found.ok) {
    throw httpError('DB_UNAVAILABLE', { cause: new Error(found.error.message) });
  }
  if (!found.value || found.value.status === 'draft') {
    log.info({ status: 'failure', reason: 'not_found' });
    throw httpError('NOT_FOUND', { detail: 'No registration link for this slug.' });
  }
  if (found.value.status === 'retired') {
    log.info({ status: 'failure', reason: 'retired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has been retired.',
    });
  }
  if (found.value.expiresAt && found.value.expiresAt.getTime() < Date.now()) {
    log.info({ status: 'failure', reason: 'expired', link_id: found.value.id });
    throw httpError('LINK_NOT_LIVE', {
      detail: 'This registration link has expired.',
    });
  }
  return found.value;
}
