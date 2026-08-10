/**
 * Campaign participant PII export (aggregator-dpg#579, #576).
 *
 *   POST /v1/campaign/export → 202; async, fire-and-forget.
 *
 * Auth is a Keycloak Bearer token; the caller's Signals org id is derived
 * from the token's `signalstack_org_id` claim and passed straight through to
 * Signals decrypt, which enforces ownership via `onboarded_by`. The route
 * never returns PII — only a queued acknowledgement; the export is delivered
 * as a pre-signed link emailed to the configured network admin. Belongs to
 * `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../services/auth/access-token.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { getMailer } from '../services/mailer/index.js';
import { putObject, signExportDownloadUrl } from '../services/object-storage/index.js';
import { runExport } from '../services/campaign-export/index.js';
import { config, exportNetworkAdminEmail } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';

const ExportRequestSchema = z
  .object({
    item_ids: z.array(z.string().uuid()).min(1).max(config.EXPORT_MAX_ITEM_IDS),
    purpose: z.string().trim().max(500).optional(),
  })
  .strict();

/** Unwrap the auth context or throw the catalogue error. Mirrors the local helper in other route modules (e.g. `support.ts`, `dashboard.ts`). */
async function requireAuth(req: FastifyRequest) {
  const result = await authenticate(req);
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
          'Decrypts the given owned items, writes a CSV to private S3, and emails a short-lived pre-signed link to the configured network admin. Auth: Keycloak Bearer token; the caller org is derived from the token signalstack_org_id claim. Fire-and-forget: returns 202 immediately.',
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

      const ss = getSignalStackWriter();
      const networkAdminEmail = exportNetworkAdminEmail();
      if (!ss || !networkAdminEmail) throw httpError('EXPORT_NOT_CONFIGURED');

      const orgId = auth.signalstackOrgId;
      if (!orgId) {
        throw httpError('FORBIDDEN', {
          detail: 'token has no signalstack_org_id claim',
          fields: { reason: 'MISSING_SIGNALSTACK_ORG' },
        });
      }

      const { item_ids, purpose } = req.body as z.infer<typeof ExportRequestSchema>;
      const log = req.log.child({ operation: 'campaign.export', org_id: orgId });

      // Fire-and-forget (interim, non-durable): the caller gets 202 at once and
      // the export runs in the background. Every failure is logged, never surfaced.
      void runExport(
        { orgId, itemIds: item_ids, ...(purpose ? { purpose } : {}), requestId: req.id },
        {
          fetchDecryptedProfiles: (q) => ss.fetchDecryptedProfiles(q),
          putObject,
          signDownloadUrl: signExportDownloadUrl,
          sendMail: (input) => getMailer().send(input),
          networkAdminEmail,
          log,
        },
      ).catch((cause: unknown) => {
        log.error({
          operation: 'campaign.export',
          status: 'failure',
          error: cause instanceof Error ? cause.message : String(cause),
          error_type: cause instanceof Error ? cause.name : 'Unknown',
        });
      });

      return reply.code(202).send({
        status: 'queued',
        message:
          'Export request submitted. A secure, time-limited download link will be emailed to the network administrator once the export is ready.',
      });
    },
  );
}
