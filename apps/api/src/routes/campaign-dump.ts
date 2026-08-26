/**
 * Campaign-manager non-PII dump download (aggregator-dpg#692).
 *
 *   GET /v1/campaign/dump → 200 { network, instance, expires_at, files[] }
 *
 * Hands the campaign manager short-lived pre-signed URLs for the three objects
 * the Signals `signals-s3-export` cron publishes, so that system no longer
 * needs S3 IAM credentials of its own. The route is an authorisation gate: it
 * never streams the data through the aggregator.
 *
 * This is the ONE campaign route with no org scoping — the caller is the
 * campaign manager's own service account, not a coordinator, and it needs every
 * aggregator's rows. The identity check in `requireCampaignSystemAuth` is
 * therefore the only control, and every call is logged.
 *
 * The exporter writes three FIXED keys, overwriting them in place with no
 * manifest and no cross-object atomicity, so there is no run to resolve and no
 * "latest" to look up. The per-file `last_modified` values are the freshness
 * contract: a caller that lands mid-run sees them disagree and decides what to
 * do. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/routes/campaign-dump
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCampaignSystemAuth } from '../campaign/auth.js';
import { getNetworkConfig } from '../services/network-config.js';
import { dumpObjectKeys } from '../services/object-storage/dump-keys.js';
import { headObject, signDownloadUrl } from '../services/object-storage/index.js';
import { campaignDumpInstanceId, config } from '../config.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { logger } from '../logger.js';

const dumpFileSchema = z.object({
  table: z.string(),
  key: z.string(),
  size_bytes: z.number().int().nonnegative(),
  last_modified: z.string().nullable(),
  url: z.string(),
});

const dumpResponseSchema = z.object({
  network: z.string(),
  instance: z.string(),
  expires_at: z.string(),
  files: z.array(dumpFileSchema),
});

/**
 * Registers the campaign non-PII dump route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignDumpRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/campaign/dump',
    {
      schema: {
        tags: ['campaign'],
        summary: 'Download the latest non-PII Signals dump',
        description:
          'Returns a short-lived pre-signed URL for each of the three objects in the latest non-PII Signals snapshot (user, items, item_actions), so the caller needs no S3 credentials. Requires the campaign-manager SYSTEM token (client_credentials grant); a coordinator token is rejected. Whole-network and not org-scoped. The exporter overwrites the three objects in place with no cross-object atomicity, so each file carries its own last_modified: a caller that lands mid-run will see them disagree and should retry. Returns all three files or an error, never a partial list.',
        security: [{ bearerAuth: [] }],
        response: {
          200: dumpResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();
      const auth = await requireCampaignSystemAuth(req);

      const instanceId = campaignDumpInstanceId();
      if (!instanceId) {
        throw httpError('DUMP_NOT_CONFIGURED', {
          fields: { reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET' },
        });
      }

      const network = (await getNetworkConfig()).network.id;
      const keys = dumpObjectKeys({
        prefix: config.CAMPAIGN_DUMP_PREFIX,
        network,
        instanceId,
      });

      // HEAD every object before signing anything: the response is
      // all-three-or-nothing, because a short `files` array would read as
      // success and the caller would silently import an incomplete snapshot.
      let heads;
      try {
        heads = await Promise.all(keys.map(async (k) => ({ ...k, head: await headObject(k.key) })));
      } catch (cause) {
        throw storageUnavailable('headObject', cause, auth.subject, started);
      }

      const missing = heads.filter((h) => h.head === null).map((h) => h.key);
      if (missing.length > 0) {
        logger.warn(
          {
            operation: 'campaignDump.serve',
            status: 'failure',
            reason: 'objects_missing',
            azp: auth.azp,
            subject: auth.subject,
            missing,
            latency_ms: Date.now() - started,
          },
          'non-PII dump objects absent under the configured key root',
        );
        throw httpError('DUMP_NOT_AVAILABLE', { fields: { missing } });
      }

      const ttlSeconds = config.CAMPAIGN_DUMP_URL_TTL_SECONDS;
      let signed;
      try {
        signed = await Promise.all(
          heads.map(async (h) => ({
            ...h,
            url: await signDownloadUrl(h.key, { ttlSeconds }),
          })),
        );
      } catch (cause) {
        throw storageUnavailable('signDownloadUrl', cause, auth.subject, started);
      }

      const files = signed.map((s) => ({
        table: s.table,
        key: s.key,
        size_bytes: s.head?.contentLength ?? 0,
        last_modified: s.head?.lastModified?.toISOString() ?? null,
        url: s.url.url,
      }));

      // The only trail this whole-network, un-org-scoped, un-rate-limited read
      // leaves. Becomes an audit-log entry when #617 lands.
      logger.info(
        {
          operation: 'campaignDump.serve',
          status: 'success',
          azp: auth.azp,
          subject: auth.subject,
          username: auth.username,
          network,
          instance: instanceId,
          ttl_seconds: ttlSeconds,
          files: files.map((f) => ({ key: f.key, last_modified: f.last_modified })),
          request_id: req.id,
          latency_ms: Date.now() - started,
        },
        'non-PII dump download URLs issued',
      );

      return reply.code(200).send({
        network,
        instance: instanceId,
        expires_at: signed[0]!.url.expiresAt,
        files,
      });
    },
  );
}

/**
 * Logs an S3 transport failure and builds the 503 to throw.
 *
 * A missing object is not a transport failure — `headObject` returns `null` for
 * `NotFound`/`NoSuchKey`, which drives the 404 instead.
 *
 * @param subOperation - The storage call that failed.
 * @param cause - The thrown value.
 * @param subject - Calling service-account subject, for the log line.
 * @param started - Request start time in ms, for `latency_ms`.
 * @returns The `DUMP_STORAGE_UNAVAILABLE` http error.
 */
function storageUnavailable(
  subOperation: string,
  cause: unknown,
  subject: string,
  started: number,
): Error {
  const message = cause instanceof Error ? cause.message : 'storage call failed';
  logger.error(
    {
      operation: 'campaignDump.serve',
      status: 'failure',
      sub_operation: subOperation,
      error: message,
      error_type: cause instanceof Error ? cause.constructor.name : typeof cause,
      subject,
      latency_ms: Date.now() - started,
    },
    'non-PII dump storage call failed',
  );
  return httpError('DUMP_STORAGE_UNAVAILABLE', { detail: message });
}
