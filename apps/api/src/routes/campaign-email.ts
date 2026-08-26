/**
 * Campaign participant email (aggregator-dpg#578).
 *
 *   POST /v1/campaign/email → 202 { job_id }
 *
 * Routes the email send through the durable campaign async-job engine (#579):
 * it validates the shared request envelope plus the email-specific `content`
 * block, fails closed on an unknown `{{placeholder}}`, applies request
 * idempotency (`Idempotency-Key`), an ingress rate-limit and a per-org
 * active-job cap, then in one transaction persists a `campaign_job` (+ one
 * `campaign_job_item` per recipient) and enqueues a single `campaign-process`
 * job carrying the job id. The decrypt → render → send work runs in
 * `apps/worker` (the `campaign` role), writing per-recipient item status back so
 * the caller can poll `GET /v1/campaign/email/{job_id}` for outcomes.
 *
 * Auth is a Keycloak Bearer token scoped to the campaign-manager client; the
 * caller's Signals org id is the token's `signalstack_org_id` claim, which also
 * scopes the decrypt (an unowned id is skipped, never leaked). The route never
 * returns PII — recipient addresses are resolved server-side in the worker and
 * never leave the aggregator. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unknownPlaceholders } from '@aggregator-dpg/campaign-template';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import { campaignEnvelopeSchema, dedupeItemIds } from '../campaign/envelope.js';
import { requireCampaignAuth, requireOrgId } from '../campaign/auth.js';
import { submitCampaignJob, readIdempotencyKey } from '../campaign/submit.js';
import { consume } from '../services/rate-limiter/index.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

/**
 * The email channel's `content` block (contract spec §6). Strict: the only
 * variance between the three campaign endpoints is this object, so an unknown
 * key here is a client error, not a silently ignored field.
 */
const emailContentSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body_markdown: z.string().min(1).max(20000),
    reply_to: z.string().email().optional(),
  })
  .strict();

/** The shared envelope with the email `content` schema substituted in. */
const emailRequestSchema = campaignEnvelopeSchema.extend({ content: emailContentSchema });

/**
 * Registers the campaign-email submit route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignEmailRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/email',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Email owned participants (async)',
        description:
          'Creates a durable campaign job that emails the given owned participants a shared message (subject + Markdown body, with an optional fixed set of {{placeholder}} tokens personalised per recipient). Body is the shared campaign envelope { item_ids, metadata[], content{subject, body_markdown, reply_to?} }. Recipient email addresses are resolved server-side and never returned. Send an Idempotency-Key header to make retries safe. Returns 202 { job_id }; poll GET /v1/campaign/email/{job_id} for per-recipient outcomes.',
        security: [{ bearerAuth: [] }],
        body: emailRequestSchema,
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

      const envelope = req.body as z.infer<typeof emailRequestSchema>;
      const itemIds = dedupeItemIds(envelope.item_ids);
      if (itemIds.length > config.CAMPAIGN_EMAIL_MAX_ITEMS) {
        throw httpError('CAMPAIGN_TOO_MANY_ITEMS', {
          fields: { max: config.CAMPAIGN_EMAIL_MAX_ITEMS, received: itemIds.length },
        });
      }

      // Fail-closed placeholder check: reject any {{token}} outside the fixed
      // set before the job is created, so a typo never ships to real inboxes.
      const unknown = unknownPlaceholders(envelope.content.subject, envelope.content.body_markdown);
      if (unknown.length > 0) {
        throw httpError('UNKNOWN_PLACEHOLDER', { fields: { unknown } });
      }

      // Ingress rate-limit, per org, in the email channel's own bucket (its
      // limits are separate from export's). Fails open on a Redis blip.
      const rl = await consume({
        namespace: 'campaign-submit-email',
        key: orgId,
        windowSeconds: config.CAMPAIGN_EMAIL_SUBMIT_WINDOW_SECONDS,
        max: config.CAMPAIGN_EMAIL_SUBMIT_MAX,
      });
      if (!rl.allowed) {
        reply.header('retry-after', String(rl.retryAfterSeconds));
        throw httpError('CAMPAIGN_RATE_LIMITED', { fields: { retry_after: rl.retryAfterSeconds } });
      }

      const store = getCampaignJobStore();

      // Per-org active-job cap, counted within the email channel only.
      const active = await store.countActiveJobs(orgId, 'email');
      if (!active.ok) throw httpError('INTERNAL', { detail: 'could not read active job count' });
      if (active.value >= config.CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG) {
        throw httpError('CAMPAIGN_ACTIVE_LIMIT', {
          fields: { max: config.CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG },
        });
      }

      const idempotencyKey = readIdempotencyKey(req);
      const jobId = await submitCampaignJob({
        req,
        store,
        channel: 'email',
        aggregatorId: auth.aggregatorId,
        signalstackOrgId: orgId,
        itemIds,
        metadata: envelope.metadata,
        // The template lives on the job row, so a retried/replayed job re-reads
        // exactly what was submitted rather than trusting a queue payload.
        content: envelope.content,
        // Audit trail only — the email channel resolves every recipient from
        // the decrypt, so this is never used as a destination.
        requestedBy: auth.email ?? auth.aggregatorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        // Retries are safe here: the worker's per-item terminal guard means a
        // retried job re-emails nobody already marked `sent`.
        attempts: config.CAMPAIGN_EMAIL_ATTEMPTS,
        enqueueErrorCode: 'EMAIL_ENQUEUE_FAILED',
        // `action` defaults to null, keeping email out of the item-level
        // active-dedup predicate — dedup is ON for voice only (batch spec §3.2).
      });

      return reply.code(202).send({
        status: 'queued' as const,
        requested: itemIds.length,
        job_id: jobId,
        message:
          'Your campaign email has been queued. Poll GET /v1/campaign/email/{job_id} for per-recipient outcomes.',
      });
    },
  );
}
