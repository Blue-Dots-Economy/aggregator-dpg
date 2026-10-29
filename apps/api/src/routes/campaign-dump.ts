/**
 * Campaign-manager non-PII dump download.
 *
 *   GET /v1/campaign/dump → 200 { network, instance, expires_at, files[] }
 *
 * Returns short-lived pre-signed URLs for the objects the Signals
 * `signals-s3-export` cron publishes, so the campaign manager needs no S3
 * credentials. The data is never streamed through the aggregator.
 *
 * This is the only campaign route with no org scoping: the caller is the
 * campaign manager's service account and gets the whole network. The identity
 * check in `requireCampaignSystemAuth` is the only control, so every exit logs
 * one `campaignDump.serve` line. Once identity is verified, every outcome also
 * writes one best-effort row to `campaign_pii_audit`, with no
 * `actorSignalstackOrgId`. A denied caller is logged, not audited.
 *
 * The exporter overwrites one fixed key per table with no manifest. Each
 * file's `last_modified` tells the caller whether they come from the same run.
 * Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/routes/campaign-dump
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCampaignSystemAuth, type CampaignSystemContext } from '../campaign/auth.js';
import { getNetworkConfig } from '../services/network-config.js';
import { dumpObjectKeys } from '../services/object-storage/dump-keys.js';
import {
  headObject,
  signDownloadUrl,
  type ObjectHead,
  type SignedDownloadUrl,
} from '../services/object-storage/index.js';
import { campaignDumpInstanceId, config } from '../config.js';
import { httpError, HttpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { logger } from '../logger.js';
import { getCampaignAuditWriter, safeAudit } from '../services/campaign-audit/index.js';

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
  missing: z.array(z.string()),
});

/** One dump key paired with its resolved HEAD, before the presence gate. */
interface DumpKeyHead {
  table: string;
  key: string;
  head: ObjectHead | null;
}

/** {@link DumpKeyHead}, narrowed to a key confirmed present in the bucket. */
interface PresentDumpKeyHead extends DumpKeyHead {
  head: ObjectHead;
}

/**
 * Registers the campaign non-PII dump route.
 *
 * @param app - The Fastify instance to attach the route to.
 */
export async function registerCampaignDumpRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/campaign/dump',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['campaign'],
        summary: 'Download the latest non-PII Signals dump',
        description:
          'Returns a short-lived pre-signed URL for each object in the latest non-PII Signals snapshot, one per file named in CAMPAIGN_DUMP_FILES (names without the .ndjson.gz extension; default: user, items, item_actions, aggregators), so the caller needs no S3 credentials. Each URL expires after CAMPAIGN_DUMP_URL_TTL_SECONDS (default 600s); fetch promptly rather than caching it. Requires the campaign-manager SYSTEM token (client_credentials grant); a coordinator token is rejected. Whole-network and not org-scoped. The exporter overwrites the objects in place with no cross-object atomicity, so each file carries its own last_modified: a caller that lands mid-run will see them disagree, meaning the snapshot is torn — treat it as such and re-fetch. Configured files absent from S3 are left out of files and listed in missing (their keys); only when none is present does it return 404 DUMP_NOT_AVAILABLE.',
        security: [{ bearerAuth: [] }],
        response: {
          200: dumpResponseSchema,
          ...errorResponses(401, 403, 404, 503),
        },
      },
    },
    async (req, reply) => {
      const started = Date.now();

      const authResult = await requireCampaignSystemAuth(req);
      if (!authResult.ok) {
        // Log every denial. `subject` is present only when the token verified.
        logger.warn(
          {
            operation: 'campaignDump.serve',
            status: 'failure',
            code: authResult.error.code,
            reason: authResult.error.fields?.reason,
            subject: authResult.subject,
            request_id: req.id,
            latency_ms: Date.now() - started,
          },
          'non-PII dump request denied',
        );
        throw authResult.error;
      }
      const auth: CampaignSystemContext = authResult.context;

      // One correlation id per request for its audit row.
      const dumpCorrelationId = randomUUID();
      // Caller-supplied header; capped in length.
      const traceId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 200);

      try {
        const instanceId = campaignDumpInstanceId();
        if (!instanceId) {
          logger.warn(
            {
              operation: 'campaignDump.serve',
              status: 'failure',
              code: 'DUMP_NOT_CONFIGURED',
              reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET',
              subject: auth.subject,
              request_id: req.id,
              latency_ms: Date.now() - started,
            },
            'non-PII dump request denied: instance not configured',
          );
          throw httpError('DUMP_NOT_CONFIGURED', {
            fields: { reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET' },
          });
        }

        const network = (await getNetworkConfig()).network.id;
        const keys = dumpObjectKeys(
          { prefix: config.CAMPAIGN_DUMP_PREFIX, network, instanceId },
          config.CAMPAIGN_DUMP_FILES,
        );

        // HEAD every object before signing any. Absent keys are left out of
        // `files` and listed in `missing`; no URL is minted for them.
        let heads: DumpKeyHead[];
        try {
          heads = await Promise.all(
            keys.map(async (k) => ({ ...k, head: await headObject(k.key) })),
          );
        } catch (cause) {
          throw storageUnavailable('headObject', cause, auth.subject, req.id, started);
        }

        const missing = heads.filter((h) => h.head === null).map((h) => h.key);
        const present = heads.filter((h): h is PresentDumpKeyHead => h.head !== null);
        if (present.length === 0) {
          logger.warn(
            {
              operation: 'campaignDump.serve',
              status: 'failure',
              reason: 'objects_missing',
              azp: auth.azp,
              subject: auth.subject,
              missing,
              request_id: req.id,
              latency_ms: Date.now() - started,
            },
            'non-PII dump objects absent under the configured key root',
          );
          throw httpError('DUMP_NOT_AVAILABLE', { fields: { missing } });
        }
        if (missing.length > 0) {
          logger.warn(
            {
              operation: 'campaignDump.serve',
              status: 'success',
              reason: 'objects_partially_missing',
              subject: auth.subject,
              missing,
              request_id: req.id,
            },
            'non-PII dump served without some configured objects',
          );
        }

        const ttlSeconds = config.CAMPAIGN_DUMP_URL_TTL_SECONDS;
        let signed: Array<PresentDumpKeyHead & { url: SignedDownloadUrl }>;
        try {
          signed = await Promise.all(
            present.map(async (h) => ({
              ...h,
              url: await signDownloadUrl(h.key, { ttlSeconds }),
            })),
          );
        } catch (cause) {
          throw storageUnavailable('signDownloadUrl', cause, auth.subject, req.id, started);
        }

        const files = signed.map((s) => ({
          table: s.table,
          key: s.key,
          size_bytes: s.head.contentLength,
          last_modified: s.head.lastModified?.toISOString() ?? null,
          url: s.url.url,
        }));

        // `last_modified` is how the caller detects files from different runs,
        // so a missing value is logged as a warning rather than passed on silently.
        const undated = files.filter((f) => f.last_modified === null).map((f) => f.table);
        if (undated.length > 0) {
          logger.warn(
            {
              operation: 'campaignDump.serve',
              status: 'success',
              reason: 'last_modified_absent',
              tables: undated,
              subject: auth.subject,
              request_id: req.id,
            },
            'S3 HEAD returned no LastModified — the caller cannot detect a torn snapshot for these tables',
          );
        }

        // Log line for the served dump; the audit row below is the durable record.
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

        // Best-effort audit row; never fails the response. No org id: the
        // access is whole-network and the token has no org claim.
        await safeAudit(
          () =>
            getCampaignAuditWriter().recordDumpAccess({
              correlationId: dumpCorrelationId,
              actorUserId: auth.subject,
              ...(auth.azp ? { actorAzp: auth.azp } : {}),
              outcome: 'succeeded',
              completedAt: new Date(),
              destination: `${config.S3_BUCKET}/${config.CAMPAIGN_DUMP_PREFIX}`,
              network,
              instance: instanceId,
              endpoint: 'GET /v1/campaign/dump',
              requestIp: req.ip,
              ...(traceId ? { traceId } : {}),
              details: {
                files: files.length,
                missing: missing.length,
                bytes: files.reduce((n, f) => n + f.size_bytes, 0),
              },
            }),
          { operation: 'campaignAudit.dump', correlation_id: dumpCorrelationId, channel: 'dump' },
        );

        return reply
          .code(200)
          .header('Cache-Control', 'no-store')
          .send({
            network,
            instance: instanceId,
            expires_at: earliestExpiry(signed),
            files,
            missing,
          });
      } catch (cause) {
        // Failures after the identity check are audited too.
        await safeAudit(
          () =>
            getCampaignAuditWriter().recordDumpAccess({
              correlationId: dumpCorrelationId,
              actorUserId: auth.subject,
              ...(auth.azp ? { actorAzp: auth.azp } : {}),
              outcome: 'failed',
              completedAt: new Date(),
              endpoint: 'GET /v1/campaign/dump',
              requestIp: req.ip,
              ...(traceId ? { traceId } : {}),
              ...(cause instanceof HttpError ? { errorCode: cause.code } : {}),
            }),
          { operation: 'campaignAudit.dump', correlation_id: dumpCorrelationId, channel: 'dump' },
        );
        throw cause;
      }
    },
  );
}

/**
 * The advertised expiry for the whole response.
 *
 * Uses the earliest `expiresAt`, so no URL expires before the reported time.
 *
 * @param signed - The presigned objects.
 * @returns The earliest `expiresAt`, as an ISO 8601 string.
 */
function earliestExpiry(signed: Array<{ url: SignedDownloadUrl }>): string {
  const earliestMs = Math.min(...signed.map((s) => Date.parse(s.url.expiresAt)));
  return new Date(earliestMs).toISOString();
}

/**
 * Logs an S3 transport failure and builds the 503 to throw.
 *
 * A missing object is not a transport failure; it answers 404 instead.
 * The raw S3 message is logged, never sent to the client.
 *
 * @param subOperation - The storage call that failed.
 * @param cause - The thrown value.
 * @param subject - Calling service-account subject, for the log line.
 * @param requestId - The inbound request id, for the log line.
 * @param started - Request start time in ms, for `latency_ms`.
 * @returns The `DUMP_STORAGE_UNAVAILABLE` http error.
 */
function storageUnavailable(
  subOperation: string,
  cause: unknown,
  subject: string,
  requestId: string,
  started: number,
): HttpError {
  const message = cause instanceof Error ? cause.message : 'storage call failed';
  logger.error(
    {
      operation: 'campaignDump.serve',
      status: 'failure',
      sub_operation: subOperation,
      error: message,
      error_type: cause instanceof Error ? cause.constructor.name : typeof cause,
      subject,
      request_id: requestId,
      latency_ms: Date.now() - started,
      // Not transient, so give a specific detail instead of "retry shortly".
      ...(isAccessDenied(cause) ? { likely_cause: 'S3_ACCESS_DENIED' } : {}),
      ...(subOperation === 'signDownloadUrl' ? { likely_cause: 'S3_CREDENTIALS' } : {}),
    },
    'non-PII dump storage call failed',
  );
  if (isAccessDenied(cause)) {
    // Without `s3:ListBucket`, a missing key answers 403. That is an IAM fault
    // (the policy is required), so it is reported, not mapped to 404.
    logger.error(
      {
        operation: 'campaignDump.serve',
        status: 'failure',
        sub_operation: subOperation,
        reason: 'S3_ACCESS_DENIED',
        subject,
        request_id: requestId,
      },
      'S3 denied the dump object — check the role grants s3:ListBucket on the bucket (without it a MISSING key returns 403, not 404)',
    );
  }
  return httpError('DUMP_STORAGE_UNAVAILABLE', { cause });
}

/**
 * Reports whether a thrown S3 error is an authorisation denial rather than an outage.
 *
 * @param cause - The value thrown by the S3 SDK.
 * @returns `true` for `AccessDenied`/`Forbidden`/HTTP 403.
 */
function isAccessDenied(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const e = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof e.name === 'string' ? e.name : '';
  return name === 'AccessDenied' || name === 'Forbidden' || e.$metadata?.httpStatusCode === 403;
}
