/**
 * Campaign participant PII export (aggregator-dpg#579, #576).
 *
 *   POST /v1/campaign/export → 202; enqueues a durable worker job.
 *
 * Auth is a Keycloak Bearer token; the caller's Signals org id is derived from
 * the token's `signalstack_org_id` claim. The route authenticates, checks the
 * aggregator (from `aggregator_id`) is active, resolves the delivery recipient
 * (the requesting user's token email, or the aggregator's contact_email as a
 * fallback), validates, and enqueues a `campaign-export` job — the decrypt →
 * CSV → S3 → email work runs in `apps/worker` (the `export` role) with BullMQ
 * retry. The export carries only the participant's name/email/phone (with
 * profile/user provenance). The route never returns PII — only a queued
 * acknowledgement; the export is delivered as a pre-signed link emailed to the
 * requesting user.
 * Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { enqueueCampaignExport } from '../services/campaign-export-queue/index.js';
import { config, campaignManagerAllowedAzp } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const ExportRequestSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(config.EXPORT_MAX_ITEM_IDS),
    purpose: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Unwrap the auth context or throw the catalogue error. Scoped to the
 * campaign-manager client(s): the `allowedAzp` override means this route accepts
 * ONLY tokens whose `azp` is in `CAMPAIGN_MANAGER_ALLOWED_AZP` (default
 * `campaign-manager`, shared with the sibling email/voice campaign routes) — a
 * portal/api/bff token is rejected here. The global `KEYCLOAK_ALLOWED_AZP`
 * excludes campaign-manager, so a campaign-manager token is in turn rejected by
 * every other route (default-deny both ways).
 */
async function requireAuth(req: FastifyRequest) {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
}

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
          "Enqueues a background job that exports the participant contact fields (name/email/phone, each with profile/user provenance) for the given owned items to a private CSV, and emails a short-lived pre-signed download link to the requesting user. Auth: Keycloak Bearer token; the caller org is derived from the token signalstack_org_id claim, and the recipient is the requesting user's token email (falling back to the aggregator contact_email). Returns 202 once the job is durably queued.",
        security: [{ bearerAuth: [] }],
        body: ExportRequestSchema,
        response: {
          202: z.object({ status: z.literal('queued'), message: z.string() }),
          ...errorResponses(400, 401, 403, 503),
        },
      },
    },
    async (req, reply) => {
      const auth = await requireAuth(req);

      const orgId = auth.signalstackOrgId;
      if (!orgId) {
        throw httpError('FORBIDDEN', {
          detail: 'token has no signalstack_org_id claim',
          fields: { reason: 'MISSING_SIGNALSTACK_ORG' },
        });
      }

      // Authorisation: the requesting aggregator must be active. Resolved before
      // enqueuing so the caller fails fast (403) rather than via a silent worker
      // failure — and it also supplies the fallback recipient email below.
      const found = await getAggregatorStore().findById(auth.aggregatorId);
      if (!found.ok || !found.value || found.value.status !== 'active') {
        throw httpError('FORBIDDEN', {
          detail: 'requesting aggregator is not active',
          fields: { reason: 'AGGREGATOR_INACTIVE' },
        });
      }

      // Delivery recipient: prefer the requesting user's own email from the
      // token (the person who triggered the export), falling back to the
      // aggregator's stored contact_email. Fail fast (403) if neither is set.
      const recipientEmail = auth.email ?? found.value.contactEmail;
      if (!recipientEmail) {
        throw httpError('FORBIDDEN', {
          detail:
            'no recipient email — the token has no email claim and the aggregator has no contact_email',
          fields: { reason: 'RECIPIENT_UNRESOLVED' },
        });
      }

      const { item_ids, purpose } = req.body as z.infer<typeof ExportRequestSchema>;

      // Validate + enqueue only. The export runs in the worker with retry; a
      // failed enqueue (e.g. Redis unreachable) is the one API-side failure we
      // surface, because a 202 must mean the job is durably queued.
      try {
        await enqueueCampaignExport({
          orgId,
          itemIds: item_ids,
          recipientEmail,
          ...(purpose ? { purpose } : {}),
          requestId: req.id,
        });
      } catch (cause) {
        throw httpError('EXPORT_ENQUEUE_FAILED', {
          detail: cause instanceof Error ? cause.message : 'failed to enqueue export',
        });
      }

      return reply.code(202).send({
        status: 'queued',
        message:
          'Export request submitted. A secure, time-limited download link will be emailed to your registered address once the export is ready.',
      });
    },
  );
}
