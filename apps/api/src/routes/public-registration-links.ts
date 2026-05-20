/**
 * Public registration link endpoints.
 *
 *   GET  /public/v1/aggregators/:orgSlug/links/:slug
 *     Anonymous resolve. Returns the public-safe shape of a live link so a
 *     BFF can render the registration form. 404 for missing or draft slugs;
 *     410 for retired or expired ones.
 *
 *   POST /public/v1/aggregators/:orgSlug/registrations/:slug
 *     Anonymous synchronous submit. Validates the body against the active
 *     participant schema for the link's domain, normalises phone+email,
 *     creates the participant + a link_submission row, and returns the
 *     submission id.
 *
 * Security model: (org_slug, slug) pair is the access token. No JWT
 * required. Aggregator scoping is implicit via the link row.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PostgresParticipantsWriter } from '@aggregator-dpg/participants-writer/postgres';
import type { ParticipantsWriterBase } from '@aggregator-dpg/participants-writer/interface';
import { getRegistrationLinksStore } from '../services/registration-links-store/index.js';
import type { RegistrationLink } from '../services/registration-links-store/index.js';
import { getSchemaLoader } from '../services/schema-loader/index.js';
import { normalisePhone } from '../services/phone.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getDb } from '../db/client.js';
import { linkSubmissions } from '../db/schema.js';
import { httpError } from '../errors/http-error.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';

let participantsWriter: ParticipantsWriterBase | null = null;
function getParticipantsWriter(): ParticipantsWriterBase {
  if (participantsWriter) return participantsWriter;
  participantsWriter = new PostgresParticipantsWriter(getDb());
  return participantsWriter;
}

/** Test helper — override the writer (e.g., inject a fake). */
export function _setParticipantsWriter(w: ParticipantsWriterBase | null): void {
  participantsWriter = w;
}

interface OrgSlugParams {
  orgSlug?: string;
  slug?: string;
}

export async function registerPublicRegistrationLinkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public/v1/aggregators/:orgSlug/links/:slug', async (req, reply) => {
    const { orgSlug, slug } = req.params as OrgSlugParams;
    if (!orgSlug || !slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
    }
    const log = req.log.child({ operation: 'public.linkResolve', org_slug: orgSlug, slug });
    const start = Date.now();

    const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

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

  app.post('/public/v1/aggregators/:orgSlug/registrations/:slug', async (req, reply) => {
    const { orgSlug, slug } = req.params as OrgSlugParams;
    if (!orgSlug || !slug) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug and slug are required.' });
    }
    const log = req.log.child({
      operation: 'public.registrationSubmit',
      org_slug: orgSlug,
      slug,
    });
    const start = Date.now();

    // Rate limit by (orgSlug, slug, ip). CAPTCHA enforcement is handled at
    // the BFF layer (Cloudflare Turnstile) — the API layer keeps a coarse
    // fallback so a misconfigured BFF can't expose unbounded write traffic.
    const ip = (req.ip ?? '0.0.0.0').toString();
    const rate = await consume({
      namespace: 'link-submit',
      key: `${orgSlug}:${slug}:${ip}`,
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

    const link = await loadLiveLinkByOrgAndSlug(orgSlug, slug, log);

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

    // 2. Normalisation. The server discards any client-supplied
    // `participant_id` (anonymous caller probing prevention) and derives the
    // dedup key from the normalised phone — same person re-submitting the
    // form hits the wrapper's ON CONFLICT path and returns outcome='skipped'.
    // Falls back to a fresh UUID when phone is absent so dedup degrades
    // gracefully for phone-optional schemas (no dedup, but still works).
    delete (body as Record<string, unknown>)['participant_id'];
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
    const participantId = phoneNormalised ?? randomUUID();

    // 3 + 4. participant UPSERT (via shared writer) and link_submission
    // INSERT must commit atomically — otherwise a crash between them leaves a
    // participant without a corresponding submission row, and the metrics
    // rollup never credits the registration.
    const writer = getParticipantsWriter();
    const txResult = await getDb().transaction(async (tx) => {
      // Bind the writer to the active tx for atomicity. If a custom writer
      // (test fake) was injected via _setParticipantsWriter, use it directly.
      type DbCtor = ConstructorParameters<typeof PostgresParticipantsWriter>[0];
      const txWriter: ParticipantsWriterBase =
        writer instanceof PostgresParticipantsWriter
          ? new PostgresParticipantsWriter(tx as unknown as DbCtor)
          : writer;

      const writeResult = await txWriter.writeLinkSubmission({
        aggregatorId: link.aggregatorId,
        type: link.domain,
        participantId,
        data: body,
        phone: phoneNormalised,
        email: emailNormalised,
        sourceLinkId: link.id,
      });

      if (!writeResult.success) {
        // Bubble DB failure to fastify so the request returns 500.
        throw new Error(writeResult.error.message);
      }
      const { outcome: writeOutcome, participant } = writeResult.value;
      const outcome: 'passed' | 'skipped' = writeOutcome;
      const participantRowId = participant.id;

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

    // Outward signalstack push for newly-inserted participants only. Skipped
    // outcomes are dedup hits — we already pushed (or chose not to) on the
    // first submit, so re-pushing here would create duplicate signalstack
    // profiles. Failures are logged but never affect the HTTP response: the
    // local DB write is the source of truth, signalstack is a downstream sink.
    if (outcome === 'passed') {
      const ss = getSignalStackWriter();
      if (ss) {
        const name = typeof body['name'] === 'string' ? (body['name'] as string) : participantRowId;
        const result = await ss.onboard({
          user: { name, phoneNumber: phoneNormalised, email: emailNormalised },
          profile: {
            item_network: config.SIGNALSTACK_ITEM_NETWORK,
            item_domain: link.domain,
            item_type: link.domain === 'provider' ? 'job_posting_1.0' : 'profile_1.0',
            item_state: body,
          },
          aggregator_id: link.aggregatorId,
        });
        if (!result.success) {
          log.warn({
            status: 'warn',
            sub: 'signalstack.push',
            error: result.error.message,
            code: result.error.code,
          });
        } else {
          log.info({
            status: 'success',
            sub: 'signalstack.push',
            user_id: result.value.user.id,
            profile_count: result.value.profiles.length,
          });
        }
      }
    }

    if (outcome === 'skipped') {
      // Surface dedup in the response status to match the design (409).
      // `participant_id` is intentionally omitted on the public path so we
      // do not leak the DB row UUID of an existing participant to an
      // anonymous caller.
      return reply.code(409).send({
        outcome,
        submission_id: submissionId,
        message: 'Already registered with this aggregator.',
      });
    }

    return reply.code(201).send({
      outcome,
      submission_id: submissionId,
    });
  });
}

/**
 * Loads a registration link by (org_slug, slug) and asserts it is currently
 * `live`. Translates store/null/expiry into the canonical 404 / 410 status
 * codes.
 */
async function loadLiveLinkByOrgAndSlug(
  orgSlug: string,
  slug: string,
  log: FastifyRequest['log'],
): Promise<RegistrationLink> {
  const store = getRegistrationLinksStore();
  const found = await store.findByOrgAndSlug(orgSlug, slug);
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
