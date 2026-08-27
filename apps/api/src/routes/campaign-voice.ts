/**
 * Campaign voice-call dispatch (aggregator-dpg#577, #602 async-job engine).
 *
 *   POST /v1/campaign/voice → 202 { status, requested, job_id }
 *
 * Mirrors `campaign-export.ts`: validates the shared request envelope, applies
 * request idempotency (`Idempotency-Key`), an ingress rate-limit and a per-org
 * active-job cap, then in one transaction persists a `campaign_job` (+ one
 * `campaign_job_item` per id, each carrying `action:'voice_call'` so the store's
 * active-dedup guard arms and a collision with another live job surfaces as
 * `duplicate_active`) and enqueues a single `campaign-process` job carrying the
 * job id. The decrypt → Raya dispatch → persist work runs in `apps/worker` (the
 * `campaign` role) with BullMQ retry, writing item + job status back.
 *
 * `content` is the caller's Raya dispatch request — validated here against
 * `voiceContentSchema` (agent id, optional batch/variables/start-options) so a
 * malformed request 400s before a job row is ever created. `action` is v1-only
 * `dispatch`; anything else fails schema validation.
 *
 * Auth is a Keycloak Bearer token scoped to the campaign-manager client; the
 * caller's Signals org id is the token's `signalstack_org_id` claim. The
 * aggregator (from `aggregator_id`) must be active. `requested_by` is resolved
 * from the verified token (its `email` claim, falling back to the aggregator's
 * `contact_email`) purely as an audit trail — the route never returns PII, only
 * `{ job_id }`. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import { enqueueCampaignProcess } from '../services/campaign-process-queue/index.js';
import { campaignEnvelopeSchema, dedupeItemIds } from '../campaign/envelope.js';
import { voiceContentSchema } from '../campaign/voice-content.js';
import { requireCampaignAuth, requireOrgId } from '../campaign/auth.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

/**
 * Registers the campaign-voice route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/voice',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Request an async voice-call campaign dispatch',
        description:
          'Creates a durable campaign job that dispatches a Raya voice-call batch to the given owned items. Body is the shared campaign envelope { item_ids, metadata[], content{} } where content is the voice dispatch request (agent_id required; action is dispatch-only in v1). Send an Idempotency-Key header to make retries safe. Returns 202 { status, requested, job_id }; poll GET /v1/campaign/voice/{job_id} for status.',
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
      // fallback requested_by email below).
      const found = await getAggregatorStore().findById(auth.aggregatorId);
      if (!found.ok || found.value?.status !== 'active') {
        throw httpError('FORBIDDEN', {
          detail: 'requesting aggregator is not active',
          fields: { reason: 'AGGREGATOR_INACTIVE' },
        });
      }

      // requested_by: the requesting user's own verified token email, falling
      // back to the aggregator's stored contact_email — audit trail only (voice
      // sends no email), but the column is NOT NULL so it must resolve.
      const requestedBy = auth.email ?? found.value.contactEmail;
      if (!requestedBy) {
        throw httpError('FORBIDDEN', {
          detail:
            'no requester identity — the token has no email claim and the aggregator has no contact_email',
          fields: { reason: 'RECIPIENT_UNRESOLVED' },
        });
      }

      const envelope = req.body as z.infer<typeof campaignEnvelopeSchema>;

      const contentParsed = voiceContentSchema.safeParse(envelope.content);
      if (!contentParsed.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'content failed voice dispatch schema validation',
          fields: { issues: contentParsed.error.issues },
        });
      }
      const content = contentParsed.data;

      const itemIds = dedupeItemIds(envelope.item_ids);
      if (itemIds.length > config.CAMPAIGN_VOICE_MAX_ITEMS) {
        throw httpError('CAMPAIGN_VOICE_TOO_MANY_ITEMS', {
          fields: { max: config.CAMPAIGN_VOICE_MAX_ITEMS, received: itemIds.length },
        });
      }

      // Ingress rate-limit, per org. Fails open on a Redis blip (see consume).
      const rl = await consume({
        // Per-channel bucket: a voice burst must not throttle export/email.
        namespace: 'campaign-submit-voice',
        key: orgId,
        windowSeconds: config.CAMPAIGN_VOICE_SUBMIT_WINDOW_SECONDS,
        max: config.CAMPAIGN_VOICE_SUBMIT_MAX,
      });
      if (!rl.allowed) {
        reply.header('retry-after', String(rl.retryAfterSeconds));
        throw httpError('CAMPAIGN_RATE_LIMITED', { fields: { retry_after: rl.retryAfterSeconds } });
      }

      const store = getCampaignJobStore();

      // Per-org active-job cap.
      const active = await store.countActiveJobs(orgId, 'voice');
      if (!active.ok) throw httpError('INTERNAL', { detail: 'could not read active job count' });
      if (active.value >= config.CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG) {
        throw httpError('CAMPAIGN_ACTIVE_LIMIT', {
          fields: { max: config.CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG },
        });
      }

      const idempotencyKey = readIdempotencyKey(req);
      const created = await store.createJob({
        aggregatorId: auth.aggregatorId,
        signalstackOrgId: orgId,
        channel: 'voice',
        metadata: envelope.metadata,
        content,
        requestedBy,
        requestId: req.id,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        items: itemIds.map((id) => ({ itemId: id, action: 'voice_call' })),
      });
      if (!created.ok) throw httpError('INTERNAL', { detail: 'could not create campaign job' });

      // Enqueue on first creation, and ALSO on a replay whose job is still
      // `queued` — that means a previous enqueue never landed, and returning
      // 202 again without re-queuing would promise a dispatch that never runs.
      // BullMQ de-duplicates on jobId, so a redundant add is a no-op.
      const needsEnqueue = created.value.created || created.value.job.status === 'queued';
      if (needsEnqueue) {
        try {
          await enqueueCampaignProcess(
            { jobId: created.value.job.id },
            { attempts: config.CAMPAIGN_VOICE_ATTEMPTS },
          );
        } catch (cause) {
          // The row is already committed. Leaving it `queued` strands it: the
          // watchdog only reaps `processing`, and `queued` counts against
          // CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG, so repeated Redis blips would
          // permanently wedge the org's cap. Mark it failed so the state is
          // truthful and the slot is released.
          const reason = cause instanceof Error ? cause.message : 'failed to enqueue voice job';
          const marked = await store.setJobStatus(created.value.job.id, 'failed', 'enqueue_failed');
          if (!marked.ok) {
            req.log.error({
              operation: 'campaignVoice.enqueue',
              status: 'failure',
              job_id: created.value.job.id,
              error: 'could not mark the un-enqueued job failed',
            });
          }
          throw httpError('VOICE_ENQUEUE_FAILED', { detail: reason });
        }
      }

      return reply.code(202).send({
        status: 'queued' as const,
        requested: itemIds.length,
        job_id: created.value.job.id,
        message: 'Voice campaign request submitted. Poll the job status endpoint for progress.',
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
