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
 * `campaign` role) with BullMQ retry, writing item + job status back. The shared
 * submit flow (auth → validate → rate-limit → cap → createJob → enqueue with
 * enqueue-failure compensation → 202) lives in `../campaign/submit-job.ts`,
 * parameterized here for the voice channel.
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
import type { FastifyInstance } from 'fastify';
import { campaignEnvelopeSchema } from '../campaign/envelope.js';
import { voiceContentSchema } from '../campaign/voice-content.js';
import { auditFieldNameEntries } from '../campaign/audit-field-names.js';
import { submitCampaignJob } from '../campaign/submit-job.js';
import { campaignSubmitResponses } from '../campaign/route-schema.js';
import { config } from '../config.js';
import { httpError } from '../errors/http-error.js';

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
        response: campaignSubmitResponses(),
      },
    },
    async (req, reply) => {
      await submitCampaignJob(req, reply, {
        channel: 'voice',
        parseContent: (rawContent) => {
          const contentParsed = voiceContentSchema.safeParse(rawContent);
          if (!contentParsed.success) {
            throw httpError('SCHEMA_VALIDATION', {
              detail: 'content failed voice dispatch schema validation',
              fields: { issues: contentParsed.error.issues },
            });
          }
          return contentParsed.data;
        },
        // `variables` are additional participant fields the caller told Raya
        // to substitute into the call script — released alongside the fixed
        // name/phone the dispatch itself requires (#617). `variables` is
        // caller-controlled free text (`voiceContentSchema` deliberately
        // leaves it unvalidated — see `../campaign/audit-field-names.ts`),
        // so it is NOT spread into the audit row verbatim: only the
        // identifier-shaped entries are recorded by name, and anything else
        // is folded into a redaction count instead of ever landing a
        // participant value in `campaign_pii_audit` (#617 fix-round-1).
        piiFields: (content) => [
          'name',
          'phone',
          ...auditFieldNameEntries((content.variables as string[] | undefined) ?? []),
        ],
        buildItem: (itemId) => ({ itemId, action: 'voice_call' }),
        maxItems: config.CAMPAIGN_VOICE_MAX_ITEMS,
        maxItemsErrorCode: 'CAMPAIGN_VOICE_TOO_MANY_ITEMS',
        // Per-channel bucket: a voice burst must not throttle export/email.
        rateLimitNamespace: 'campaign-submit-voice',
        submitWindowSeconds: config.CAMPAIGN_VOICE_SUBMIT_WINDOW_SECONDS,
        submitMax: config.CAMPAIGN_VOICE_SUBMIT_MAX,
        maxActivePerOrg: config.CAMPAIGN_VOICE_MAX_ACTIVE_PER_ORG,
        attempts: config.CAMPAIGN_VOICE_ATTEMPTS,
        enqueueFailedErrorCode: 'VOICE_ENQUEUE_FAILED',
        enqueueFailedFallbackMessage: 'failed to enqueue voice job',
        logOperation: 'campaignVoice.enqueue',
        successMessage:
          'Voice campaign request submitted. Poll the job status endpoint for progress.',
      });
    },
  );
}
