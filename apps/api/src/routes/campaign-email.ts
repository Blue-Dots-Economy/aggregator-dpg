/**
 * Campaign participant email (aggregator-dpg#578, #602 async-job engine).
 *
 *   POST /v1/campaign/email → 202 { status, requested, job_id }
 *
 * Mirrors `campaign-export.ts` and `campaign-voice.ts`: validates the shared
 * request envelope, applies request idempotency (`Idempotency-Key`), an ingress
 * rate-limit and a per-org active-job cap, then in one transaction persists a
 * `campaign_job` (+ one `campaign_job_item` per recipient, each with
 * `action: null` so the store's active-dedup guard stays disarmed — dedup is
 * voice-only) and enqueues a single `campaign-process` job carrying the job id.
 * The decrypt → render → send work runs in `apps/worker` (the `campaign` role)
 * with BullMQ retry, writing per-recipient item status back so the caller can
 * poll `GET /v1/campaign/email/{job_id}` for outcomes. The shared submit flow
 * (auth → validate → rate-limit → cap → createJob → enqueue with
 * enqueue-failure compensation → 202) lives in `../campaign/submit-job.ts`,
 * parameterized here for the email channel.
 *
 * `content` is the message — validated here against `emailContentSchema`
 * (subject, Markdown body, optional `reply_to`), with the `{{placeholder}}`
 * allow-list enforced fail-closed so a typo 400s before a job row exists.
 *
 * Auth is a Keycloak Bearer token scoped to the campaign-manager client; the
 * caller's Signals org id is the token's `signalstack_org_id` claim, which also
 * scopes the decrypt (an unowned id is skipped, never leaked). The route never
 * returns PII — recipient addresses are resolved server-side in the worker and
 * never leave the aggregator. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance } from 'fastify';
import { requiredContactFields } from '@aggregator-dpg/campaign-template';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { parseEmailContent } from '../campaign/email-content.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';

/**
 * Registers the campaign-email route.
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
        body: campaignEnvelopeSchema,
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'email',
        parseContent: parseEmailContent,
        // Reuse the same placeholder→field mapping the worker uses to decide
        // what to decrypt, so the audit row never drifts from reality (#617).
        piiFields: (content) =>
          requiredContactFields(content.subject as string, content.body_markdown as string),
        // `action: null` keeps email out of the item-level active-dedup
        // predicate — dedup is ON for voice only (batch spec §3.2).
        buildItem: (itemId) => ({ itemId, action: null }),
        maxItems: config.CAMPAIGN_EMAIL_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_TOO_MANY_ITEMS',
        // Per-channel bucket: an email burst must not throttle export/voice.
        rateLimitNamespace: 'campaign-submit-email',
        submitWindowSeconds: config.CAMPAIGN_EMAIL_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_EMAIL_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_EMAIL_MAX_ACTIVE_PER_ORG,
        // Retries stay ON (3, not 1): the worker's per-item terminal-status
        // guard means a retried job re-emails nobody already marked `sent`.
        attempts: config.CAMPAIGN_EMAIL_ATTEMPTS,
        enqueueFailedErrorCode: 'EMAIL_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue email',
        logOperation: 'campaignEmail.enqueue',
        successMessage:
          'Your campaign email has been queued. Poll GET /v1/campaign/email/{job_id} for per-recipient outcomes.',
      });
    },
  );
}
