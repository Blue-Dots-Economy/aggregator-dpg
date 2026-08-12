/**
 * Campaign participant email (aggregator-dpg#578).
 *
 *   POST /v1/campaign/email → 202; enqueues a durable worker job.
 *
 * Auth is a Keycloak Bearer token scoped to the campaign-manager client(s). The
 * route authenticates, derives the caller's Signals org id from the token's
 * `signalstack_org_id` claim, validates the request (recipients + subject +
 * Markdown body) and its placeholders, and enqueues a `campaign-email` job — the
 * decrypt → render → send work runs in `apps/worker` (the `email` role) with
 * send-once semantics. The route never returns PII — only a queued
 * acknowledgement; recipient emails are resolved server-side in the worker and
 * never leave the aggregator. Belongs to `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { unknownPlaceholders } from '@aggregator-dpg/campaign-template';
import { authenticate } from '../services/auth/access-token.js';
import { enqueueCampaignEmail } from '../services/campaign-email-queue/index.js';
import { config, campaignManagerAllowedAzp } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const EmailRequestSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(config.EMAIL_MAX_RECIPIENTS),
    subject: z.string().trim().min(1).max(200),
    body_markdown: z.string().min(1).max(20000),
    reply_to: z.string().email().optional(),
    purpose: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Unwrap the auth context or throw the catalogue error. Scoped to the
 * campaign-manager client(s): the `allowedAzp` override means this route accepts
 * ONLY tokens whose `azp` is in `CAMPAIGN_MANAGER_ALLOWED_AZP` (default
 * `campaign-manager`) — a portal/api/bff token is rejected here, and because the
 * global `KEYCLOAK_ALLOWED_AZP` excludes campaign-manager, a campaign-manager
 * token is in turn rejected by every other route (default-deny both ways).
 */
async function requireAuth(req: FastifyRequest) {
  const result = await authenticate(req, { allowedAzp: campaignManagerAllowedAzp() });
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, { detail: result.error.message, fields: { reason: result.error.code } });
}

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
        summary: 'Send an email to owned participants (async)',
        description:
          'Enqueues a background job that emails the given owned participants a shared message (subject + Markdown body, with an optional fixed set of {{placeholder}} tokens personalised per recipient). Recipient email addresses are resolved server-side and never returned. Auth: Keycloak Bearer token scoped to the campaign-manager client; the caller org is derived from the token signalstack_org_id claim. Returns 202 once the job is durably queued.',
        security: [{ bearerAuth: [] }],
        body: EmailRequestSchema,
        response: {
          202: z.object({
            status: z.literal('queued'),
            requested: z.number().int().nonnegative(),
            message: z.string(),
          }),
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

      const body = req.body as z.infer<typeof EmailRequestSchema>;

      // Fail-closed placeholder check: reject any {{token}} outside the fixed
      // set before enqueuing, so a typo never ships to real inboxes.
      const unknown = unknownPlaceholders(body.subject, body.body_markdown);
      if (unknown.length > 0) {
        throw httpError('UNKNOWN_PLACEHOLDER', { fields: { unknown } });
      }

      // Validate + enqueue only. The send runs in the worker with send-once
      // semantics; a failed enqueue (e.g. Redis unreachable) is the one
      // API-side failure we surface, because a 202 must mean durably queued.
      try {
        await enqueueCampaignEmail({
          orgId,
          itemIds: body.item_ids,
          subject: body.subject,
          bodyMarkdown: body.body_markdown,
          ...(body.reply_to ? { replyTo: body.reply_to } : {}),
          ...(body.purpose ? { purpose: body.purpose } : {}),
          requestId: req.id,
        });
      } catch (cause) {
        throw httpError('EMAIL_ENQUEUE_FAILED', {
          detail: cause instanceof Error ? cause.message : 'failed to enqueue email',
        });
      }

      return reply.code(202).send({
        status: 'queued',
        requested: body.item_ids.length,
        message:
          'Your campaign email has been queued and will be sent to the resolved participants shortly.',
      });
    },
  );
}
