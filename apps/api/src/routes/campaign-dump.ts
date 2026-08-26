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
 * therefore the only control, so EVERY exit — success, a denied caller, and a
 * misconfigured deployment, not just the happy path — emits one
 * `campaignDump.serve` log line; that is this route's whole audit trail.
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
import { requireCampaignSystemAuth, type CampaignSystemContext } from '../campaign/auth.js';
import { getNetworkConfig } from '../services/network-config.js';
import { dumpObjectKeys, type DumpTable } from '../services/object-storage/dump-keys.js';
import {
  headObject,
  signDownloadUrl,
  type ObjectHead,
  type SignedDownloadUrl,
} from '../services/object-storage/index.js';
import { campaignDumpInstanceId, config } from '../config.js';
import { HttpError, httpError } from '../errors/http-error.js';
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

/** One dump key paired with its resolved HEAD, before the presence gate. */
interface DumpKeyHead {
  table: DumpTable;
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

      let auth: CampaignSystemContext;
      try {
        auth = await requireCampaignSystemAuth(req);
      } catch (cause) {
        // The identity check is this route's only control, so a denial is as
        // audit-worthy as a success — log it before the generic error handler's
        // undifferentiated line, with the fields that handler doesn't carry
        // (`operation`, `latency_ms`).
        if (cause instanceof HttpError) {
          logger.warn(
            {
              operation: 'campaignDump.serve',
              status: 'failure',
              code: cause.code,
              reason: cause.fields?.reason,
              latency_ms: Date.now() - started,
            },
            'non-PII dump request denied',
          );
        }
        throw cause;
      }

      const instanceId = campaignDumpInstanceId();
      if (!instanceId) {
        logger.warn(
          {
            operation: 'campaignDump.serve',
            status: 'failure',
            code: 'DUMP_NOT_CONFIGURED',
            reason: 'CAMPAIGN_DUMP_INSTANCE_ID_UNSET',
            subject: auth.subject,
            latency_ms: Date.now() - started,
          },
          'non-PII dump request denied: instance not configured',
        );
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
      // No URL is minted until every key has cleared this gate.
      let heads: DumpKeyHead[];
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

      // Narrow past the presence gate through a type guard rather than
      // carrying `ObjectHead | null` (and `?? 0` / `?? null` defensive
      // fallbacks) into the response build: a genuine 0-byte object (the
      // exporter writes one for a zero-row table) must stay distinguishable
      // from a missing one, and `contentLength` must not silently become 0
      // for the wrong reason. The length check is unreachable given the
      // `missing` gate above — it guards the narrowing itself, so a future
      // refactor that separates the two checks fails loudly instead of
      // shipping a corrupted response.
      const present = heads.filter((h): h is PresentDumpKeyHead => h.head !== null);
      if (present.length !== keys.length) {
        throw new Error('campaignDump: head/key count mismatch after the presence gate');
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
        throw storageUnavailable('signDownloadUrl', cause, auth.subject, started);
      }

      const files = signed.map((s) => ({
        table: s.table,
        key: s.key,
        size_bytes: s.head.contentLength,
        last_modified: s.head.lastModified?.toISOString() ?? null,
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
        expires_at: earliestExpiry(signed),
        files,
      });
    },
  );
}

/**
 * The advertised expiry for the whole response.
 *
 * The three presigns run concurrently, so their `expiresAt` values can differ
 * by however long the slowest one took. Reporting the earliest — never an
 * arbitrary one of the three — guarantees the caller never sees an expiry that
 * outlives one of the URLs it describes.
 *
 * @param signed - The three presigned objects.
 * @returns The earliest `expiresAt`, as an ISO 8601 string.
 */
function earliestExpiry(signed: Array<{ url: SignedDownloadUrl }>): string {
  const earliestMs = Math.min(...signed.map((s) => Date.parse(s.url.expiresAt)));
  return new Date(earliestMs).toISOString();
}

/**
 * Logs an S3 transport failure and builds the 503 to throw.
 *
 * A missing object is not a transport failure — `headObject` returns `null` for
 * `NotFound`/`NoSuchKey`, which drives the 404 instead.
 *
 * The raw SDK message is logged here but never sent to the client: `cause` is
 * attached to the thrown `HttpError` (log-only, per `HttpErrorOptions`) so the
 * response carries only the catalogue's generic `DUMP_STORAGE_UNAVAILABLE`
 * detail, never a raw S3 error string.
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
  return httpError('DUMP_STORAGE_UNAVAILABLE', { cause });
}
