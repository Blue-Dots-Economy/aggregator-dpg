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
 * `campaignDump.serve` log line. Once identity is verified, every outcome
 * (served or failed) additionally writes exactly one row to the append-only
 * `campaign_pii_audit` table (aggregator-dpg#617), best-effort via
 * `safeAudit` — that row, not this log line, is the durable/queryable trail
 * compliance reads. It carries no `actorOrgId`: the caller's token has no org
 * claim, and this route serves the whole network, so an org would misrepresent
 * the access. An outright denial (bad/missing/wrong-client token) is not
 * audited there, only logged — no row is possible without a verified actor.
 *
 * The exporter writes three FIXED keys, overwriting them in place with no
 * manifest and no cross-object atomicity, so there is no run to resolve and no
 * "latest" to look up. The per-file `last_modified` values are the freshness
 * contract: a caller that lands mid-run sees them disagree and decides what to
 * do. Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/routes/campaign-dump
 */
import { randomUUID } from 'node:crypto';
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
          'Returns a short-lived pre-signed URL for each of the three objects in the latest non-PII Signals snapshot (user, items, item_actions), so the caller needs no S3 credentials. Each URL expires after CAMPAIGN_DUMP_URL_TTL_SECONDS (default 600s); fetch promptly rather than caching it. Requires the campaign-manager SYSTEM token (client_credentials grant); a coordinator token is rejected. Whole-network and not org-scoped. The exporter overwrites the three objects in place with no cross-object atomicity, so each file carries its own last_modified: a caller that lands mid-run will see them disagree, meaning the snapshot is torn — treat it as such and re-fetch. Returns all three files or an error, never a partial list.',
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
        // The identity check is this route's only control, so a denial is as
        // audit-worthy as a success — log it before the generic error handler's
        // undifferentiated line, with the fields that handler doesn't carry
        // (`operation`, `latency_ms`, `request_id`). `subject` is present only
        // when the token itself verified (the NOT_SYSTEM_CLIENT case) — see
        // `CampaignSystemAuthResult`.
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

      // The dump is synchronous and has no job to borrow a correlation id
      // from, so one is minted per request (#617); it ties this request's
      // single audit row together whether the request succeeds or fails.
      const dumpCorrelationId = randomUUID();
      // Caller-supplied header — cap it so an oversized value can't bloat the
      // audit row (#617 cheap item).
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
          heads = await Promise.all(
            keys.map(async (k) => ({ ...k, head: await headObject(k.key) })),
          );
        } catch (cause) {
          throw storageUnavailable('headObject', cause, auth.subject, req.id, started);
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
              request_id: req.id,
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
          throw storageUnavailable('signDownloadUrl', cause, auth.subject, req.id, started);
        }

        const files = signed.map((s) => ({
          table: s.table,
          key: s.key,
          size_bytes: s.head.contentLength,
          last_modified: s.head.lastModified?.toISOString() ?? null,
          url: s.url.url,
        }));

        // `last_modified` is the caller's ONLY signal that the three objects came
        // from different runs, so a null quietly removes the one control the
        // torn-snapshot design depends on. S3 should always return LastModified
        // on a successful HEAD; if it did not, say so rather than shipping a
        // silent null.
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

        // The primary trail this whole-network, un-org-scoped,
        // un-rate-limited read leaves — kept alongside the append-only
        // `campaign_pii_audit` row (#617) written just below, which is the
        // durable/queryable copy compliance reads from directly.
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

        // Best-effort audit row (#617) — never blocks or fails the response;
        // see `../services/campaign-audit/index.ts`. No `actorOrgId`: this
        // route is whole-network by design and the caller's token carries no
        // org claim, so one must never be fabricated here (see
        // `DumpAuditInput`).
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
              details: { files: files.length, bytes: files.reduce((n, f) => n + f.size_bytes, 0) },
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
          });
      } catch (cause) {
        // Every failure past this point in the request is audited too — the
        // identity check above is the route's control, but once it has
        // passed, a failed attempt to serve the dump is as much a PII-adjacent
        // access event as a served one (#617).
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
      // Neither of these is transient, so the catalogue's "retry shortly" is
      // wrong for them and the operator needs to know which they hit.
      ...(isAccessDenied(cause) ? { likely_cause: 'S3_ACCESS_DENIED' } : {}),
      ...(subOperation === 'signDownloadUrl' ? { likely_cause: 'S3_CREDENTIALS' } : {}),
    },
    'non-PII dump storage call failed',
  );
  if (isAccessDenied(cause)) {
    // A HEAD on a key the caller cannot list returns 403, not 404, so a bucket
    // policy without `s3:ListBucket` turns the ordinary "not published yet"
    // cold start into a 503 that never clears. Deliberately NOT remapped to
    // 404: `infra/env.template` already requires `s3:ListBucket`, so a 403 here
    // means the deployment has deviated from that policy — and reporting it as
    // "not published yet" would hide a real IAM fault rather than surface it.
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
 * Whether a thrown S3 error is an authorisation denial rather than an outage.
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
