/**
 * Campaign participant PII export (interim, aggregator-dpg#579).
 *
 *   POST /v1/campaign/export → 202; async, fire-and-forget.
 *
 * Interim auth is the `x-org-id` header (the caller's Signals org id), passed
 * straight through to Signals decrypt, which enforces ownership via
 * `onboarded_by`. Swapped for KC-token validation when #576 lands. The route
 * never returns PII — only a queued acknowledgement; the export is delivered as
 * a pre-signed link emailed to the configured network admin. Belongs to
 * `@aggregator-dpg/api`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
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

/** Reads and trims the interim `x-org-id` header; undefined when absent/blank. */
function orgIdHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers['x-org-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Registers the campaign-export route. Deliberately NOT under the session-auth
 * hook — the external caller has no session; interim auth is `x-org-id`.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/campaign/export',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Request an async participant PII export (interim)',
        description:
          'Decrypts the given owned items, writes a CSV to private S3, and emails a short-lived pre-signed link to the configured network admin. Interim auth: x-org-id header (Signals org id). Fire-and-forget: returns 202 immediately.',
        body: ExportRequestSchema,
        response: {
          202: z.object({ status: z.literal('queued'), message: z.string() }),
          ...errorResponses(400, 401, 503),
        },
      },
    },
    async (req, reply) => {
      const orgId = orgIdHeader(req);
      if (!orgId) throw httpError('MISSING_ORG_ID');

      const ss = getSignalStackWriter();
      const networkAdminEmail = exportNetworkAdminEmail();
      if (!ss || !networkAdminEmail) throw httpError('EXPORT_NOT_CONFIGURED');

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
