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
 * retry, writing item + job status back. The shared submit flow (auth →
 * validate → rate-limit → cap → createJob → enqueue with enqueue-failure
 * compensation → 202) lives in `../campaign/submit-job.ts`, parameterized here
 * for the export channel.
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
import type { FastifyInstance } from 'fastify';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';

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
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'export',
        parseContent: (rawContent) => rawContent as Record<string, unknown>,
        buildItem: (itemId) => ({ itemId, action: null }),
        maxItems: config.CAMPAIGN_EXPORT_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_TOO_MANY_ITEMS',
        // Per-channel bucket: an export burst must not throttle email/voice.
        rateLimitNamespace: 'campaign-submit-export',
        submitWindowSeconds: config.CAMPAIGN_EXPORT_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_EXPORT_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_EXPORT_MAX_ACTIVE_PER_ORG,
        attempts: config.CAMPAIGN_EXPORT_ATTEMPTS,
        enqueueFailedErrorCode: 'EXPORT_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue export',
        logOperation: 'campaignExport.enqueue',
        successMessage:
          'Export request submitted. A secure, time-limited download link will be emailed to your registered address once the export is ready.',
      });
    },
  );
}
