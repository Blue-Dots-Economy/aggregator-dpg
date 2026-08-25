/**
 * Campaign participant PII export (aggregator-dpg#579, #576).
 *
 *   POST /v1/campaign/export → 202 { job_id }
 *
 * Routes the export through the durable campaign async-job engine: it validates
 * the shared request envelope, applies request idempotency (`Idempotency-Key`),
 * an ingress rate-limit and a per-org active-job cap, then in one transaction
 * persists a `campaign_job` (+ one `campaign_job_item` per id) and enqueues a
 * single `campaign-process` job carrying the job id. The decrypt → CSV → S3 →
 * email-link work runs in `apps/worker` (the `campaign` role) with BullMQ
 * retry, writing item + job status back.
 *
 * Auth is a Keycloak Bearer token scoped to the campaign-manager client; the
 * caller's Signals org id is the token's `signalstack_org_id` claim. The
 * aggregator (from `aggregator_id`) must be active. The delivery recipient is
 * resolved here from the verified token (its `email` claim, falling back to the
 * aggregator's `contact_email`) and stored as the job's `requested_by` — a
 * server-set value the worker trusts, so the caller can never redirect the
 * export via the request body. The route never returns PII — only `{ job_id }`.
 * Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import { enqueueCampaignProcess } from '../services/campaign-process-queue/index.js';
import { campaignEnvelopeSchema, dedupeItemIds } from '../campaign/envelope.js';
import { requireCampaignAuth, requireOrgId } from '../campaign/auth.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

/**
 * Registers the campaign-export route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/export',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Request an async participant PII export',
        description:
          'Creates a durable campaign job that exports the participant contact fields (name/email/phone, each with profile/user provenance) for the given owned items to a private CSV, and emails a short-lived pre-signed download link to the requesting user. Body is the shared campaign envelope { item_ids, metadata[], content{} }. Send an Idempotency-Key header to make retries safe. Returns 202 { job_id }; poll GET /v1/campaign/export/{job_id} for status.',
        security: [{ bearerAuth: [] }],
        body: campaignEnvelopeSchema,
        response: {
          202: z.object({
            status: z.literal('queued'),
            requested: z.number().int(),
            job_id: z.string().uuid(),
            message: z.string(),
          }),
          ...errorResponses(400, 401, 403, 429, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireCampaignAuth(req);
      const orgId = requireOrgId(auth);

      // The requesting aggregator must be active (fail fast, and it supplies the
      // fallback recipient email below).
      const found = await getAggregatorStore().findById(auth.aggregatorId);
      if (!found.ok || found.value?.status !== 'active') {
        throw httpError('FORBIDDEN', {
          detail: 'requesting aggregator is not active',
          fields: { reason: 'AGGREGATOR_INACTIVE' },
        });
      }

      // Delivery recipient: the requesting user's own verified token email,
      // falling back to the aggregator's stored contact_email. Stored as
      // requested_by (server-set — the caller can't redirect the export).
      const recipientEmail = auth.email ?? found.value.contactEmail;
      if (!recipientEmail) {
        throw httpError('FORBIDDEN', {
          detail:
            'no recipient email — the token has no email claim and the aggregator has no contact_email',
          fields: { reason: 'RECIPIENT_UNRESOLVED' },
        });
      }

      const envelope = req.body as z.infer<typeof campaignEnvelopeSchema>;
      const itemIds = dedupeItemIds(envelope.item_ids);
      if (itemIds.length > config.CAMPAIGN_EXPORT_MAX_ITEMS) {
        throw httpError('CAMPAIGN_TOO_MANY_ITEMS', {
          fields: { max: config.CAMPAIGN_EXPORT_MAX_ITEMS, received: itemIds.length },
        });
      }

      // Ingress rate-limit, per org, in the export channel's own bucket (its
      // limits are separate from email's). Fails open on a Redis blip.
      const rl = await consume({
        // Per-channel bucket: an export burst must not throttle email/voice.
        namespace: 'campaign-submit-export',
        key: orgId,
        windowSeconds: config.CAMPAIGN_EXPORT_SUBMIT_WINDOW_SECONDS,
        max: config.CAMPAIGN_EXPORT_SUBMIT_MAX,
      });
      if (!rl.allowed) {
        reply.header('retry-after', String(rl.retryAfterSeconds));
        throw httpError('CAMPAIGN_RATE_LIMITED', { fields: { retry_after: rl.retryAfterSeconds } });
      }

      const store = getCampaignJobStore();

      // Per-org active-job cap.
      const active = await store.countActiveJobs(orgId, 'export');
      if (!active.ok) throw httpError('INTERNAL', { detail: 'could not read active job count' });
      if (active.value >= config.CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG) {
        throw httpError('CAMPAIGN_ACTIVE_LIMIT', {
          fields: { max: config.CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG },
        });
      }

      const idempotencyKey = readIdempotencyKey(req);
      const created = await store.createJob({
        aggregatorId: auth.aggregatorId,
        signalstackOrgId: orgId,
        channel: 'export',
        metadata: envelope.metadata,
        content: envelope.content,
        requestedBy: recipientEmail,
        requestId: req.id,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        items: itemIds.map((id) => ({ itemId: id, action: null })),
      });
      if (!created.ok) throw httpError('INTERNAL', { detail: 'could not create campaign job' });

      // Only enqueue on first creation. An idempotency replay returns the same
      // job id without queuing a duplicate.
      if (created.value.created) {
        try {
          await enqueueCampaignProcess(
            { jobId: created.value.job.id },
            { attempts: config.CAMPAIGN_EXPORT_ATTEMPTS },
          );
        } catch (cause) {
          throw httpError('EXPORT_ENQUEUE_FAILED', {
            detail: cause instanceof Error ? cause.message : 'failed to enqueue export',
          });
        }
      }

      return reply.code(202).send({
        status: 'queued' as const,
        requested: itemIds.length,
        job_id: created.value.job.id,
        message:
          'Export request submitted. A secure, time-limited download link will be emailed to your registered address once the export is ready.',
      });
    },
  );
}

/** Reads the `Idempotency-Key` request header (Fastify lowercases header names). */
function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}
