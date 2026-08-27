/**
 * Shared async-job submission flow for the campaign channels (aggregator-dpg#577,
 * #579).
 *
 * `campaign-export.ts` and `campaign-voice.ts` are near-identical: auth →
 * active-aggregator check → requester/recipient resolution → content parsing →
 * item-id dedup/cap → ingress rate-limit → per-org active-job cap → createJob
 * → enqueue (re-enqueuing a `queued` idempotency replay) → enqueue-failure
 * compensation (mark the job `failed` so it doesn't strand the org's active
 * slot) → `202`. This module owns that shared flow; each route supplies its
 * channel-specific knobs (config keys, error codes, content shape, item
 * action, log/message text) via {@link SubmitCampaignJobOptions} and stays
 * responsible only for its own Fastify route schema/response shape.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getCampaignJobStore } from '../services/campaign-job-store/index.js';
import type {
  CampaignChannel,
  CreateJobItemInput,
  JobRecord,
} from '../services/campaign-job-store/index.js';
import { enqueueCampaignProcess } from '../services/campaign-process-queue/index.js';
import { dedupeItemIds } from './envelope.js';
import type { campaignEnvelopeSchema } from './envelope.js';
import { requireCampaignAuth, requireOrgId } from './auth.js';
import { consume } from '../services/rate-limiter/index.js';
import { httpError } from '../errors/http-error.js';
import type { ErrorCode } from '../errors/codes.js';

/** Channel-specific knobs consumed by {@link submitCampaignJob}. */
export interface SubmitCampaignJobOptions {
  /** The campaign channel this submission belongs to. */
  channel: CampaignChannel;
  /**
   * Parses/validates the envelope's raw `content` into the job's persisted
   * `content`. Export passes it through untouched; voice validates it against
   * `voiceContentSchema`. Throw (via `httpError(...)`) to fail the request
   * before any row is created.
   */
  parseContent: (rawContent: unknown) => Record<string, unknown>;
  /** Builds one job item's `action` column from a deduped item id. */
  buildItem: (itemId: string) => CreateJobItemInput;
  /** Per-request item cap (`CAMPAIGN_<CHANNEL>_MAX_ITEMS`). */
  maxItems: number;
  /** Error code thrown when `maxItems` is exceeded. */
  maxItemsErrorCode: ErrorCode;
  /** Rate-limiter bucket namespace — per-channel so one channel's burst can't throttle another. */
  rateLimitNamespace: string;
  /** Rate-limiter window, in seconds. */
  submitWindowSeconds: number;
  /** Rate-limiter max requests per window. */
  submitMax: number;
  /** Per-org active-job cap (`CAMPAIGN_<CHANNEL>_MAX_ACTIVE_PER_ORG`). */
  maxActivePerOrg: number;
  /** BullMQ `attempts` passed to `enqueueCampaignProcess`. */
  attempts: number;
  /** Error code thrown when the post-commit enqueue fails. */
  enqueueFailedErrorCode: ErrorCode;
  /** Fallback detail text when the enqueue rejection isn't an `Error`. */
  enqueueFailedFallbackMessage: string;
  /** `operation` field for the structured log emitted when marking a stranded job failed also fails. */
  logOperation: string;
  /** `message` field of the `202` response body. */
  successMessage: string;
}

/**
 * Runs the shared campaign-job submission flow for one channel and sends the
 * `202` response itself. See the module doc for what's shared vs.
 * channel-specific.
 *
 * @param req - The Fastify request. `req.body` must already have been
 *   validated against `campaignEnvelopeSchema` by the route's Fastify schema.
 * @param reply - The Fastify reply — this function sends the final response.
 * @param opts - Channel-specific config, see {@link SubmitCampaignJobOptions}.
 */
export async function submitCampaignJob(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SubmitCampaignJobOptions,
): Promise<void> {
  const auth = await requireCampaignAuth(req);
  const orgId = requireOrgId(auth);
  const requestedBy = await resolveRequestedBy(auth.aggregatorId, auth.email);

  const envelope = req.body as z.infer<typeof campaignEnvelopeSchema>;
  const content = opts.parseContent(envelope.content);

  const itemIds = dedupeItemIds(envelope.item_ids);
  if (itemIds.length > opts.maxItems) {
    throw httpError(opts.maxItemsErrorCode, {
      fields: { max: opts.maxItems, received: itemIds.length },
    });
  }

  // Ingress rate-limit, per org. Fails open on a Redis blip (see consume).
  const rl = await consume({
    namespace: opts.rateLimitNamespace,
    key: orgId,
    windowSeconds: opts.submitWindowSeconds,
    max: opts.submitMax,
  });
  if (!rl.allowed) {
    reply.header('retry-after', String(rl.retryAfterSeconds));
    throw httpError('CAMPAIGN_RATE_LIMITED', { fields: { retry_after: rl.retryAfterSeconds } });
  }

  const store = getCampaignJobStore();

  // Per-org active-job cap.
  const active = await store.countActiveJobs(orgId, opts.channel);
  if (!active.ok) throw httpError('INTERNAL', { detail: 'could not read active job count' });
  if (active.value >= opts.maxActivePerOrg) {
    throw httpError('CAMPAIGN_ACTIVE_LIMIT', { fields: { max: opts.maxActivePerOrg } });
  }

  const idempotencyKey = readIdempotencyKey(req);
  const created = await store.createJob({
    aggregatorId: auth.aggregatorId,
    signalstackOrgId: orgId,
    channel: opts.channel,
    metadata: envelope.metadata,
    content,
    requestedBy,
    requestId: req.id,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    items: itemIds.map(opts.buildItem),
  });
  if (!created.ok) throw httpError('INTERNAL', { detail: 'could not create campaign job' });

  await enqueueWithCompensation(created.value.job, created.value.created, opts, req, store);

  await reply.code(202).send({
    status: 'queued' as const,
    requested: itemIds.length,
    job_id: created.value.job.id,
    message: opts.successMessage,
  });
}

/**
 * Verifies the requesting aggregator is active and resolves the
 * `requested_by` audit-trail email — the token's own verified email claim,
 * falling back to the aggregator's stored `contact_email`. Split out of
 * {@link submitCampaignJob} to keep that function's cognitive complexity in
 * check; behaviour (including both `FORBIDDEN` failure modes) is unchanged.
 *
 * @param aggregatorId - The requesting aggregator's id (from the auth token).
 * @param tokenEmail - The token's own `email` claim, if present.
 * @returns The resolved requester email.
 * @throws The `FORBIDDEN` http error if the aggregator isn't active, or if no
 *   requester identity resolves (no token email claim and no `contact_email`).
 */
async function resolveRequestedBy(
  aggregatorId: string,
  tokenEmail: string | undefined,
): Promise<string> {
  // The requesting aggregator must be active (fail fast, and it supplies the
  // fallback requester/recipient email below).
  const found = await getAggregatorStore().findById(aggregatorId);
  if (!found.ok || found.value?.status !== 'active') {
    throw httpError('FORBIDDEN', {
      detail: 'requesting aggregator is not active',
      fields: { reason: 'AGGREGATOR_INACTIVE' },
    });
  }

  // requested_by: the requesting user's own verified token email, falling
  // back to the aggregator's stored contact_email — audit trail only, but the
  // column is NOT NULL so it must resolve.
  const requestedBy = tokenEmail ?? found.value.contactEmail;
  if (!requestedBy) {
    throw httpError('FORBIDDEN', {
      detail:
        'no requester identity — the token has no email claim and the aggregator has no contact_email',
      fields: { reason: 'RECIPIENT_UNRESOLVED' },
    });
  }
  return requestedBy;
}

/**
 * Enqueues the just-created (or idempotency-replayed) campaign job, and
 * compensates if the enqueue call itself fails. Split out of
 * {@link submitCampaignJob} to keep that function's cognitive complexity in
 * check; behaviour is unchanged — see the module doc for the enqueue/replay/
 * compensation contract this implements.
 *
 * @param job - The created/replayed job row (id + current status).
 * @param wasCreated - Whether this call created the row (vs. an idempotency
 *   replay of an existing one).
 * @param opts - Channel-specific enqueue/error-code/log knobs.
 * @param req - The Fastify request — used for structured logging only.
 * @param store - The campaign job store, for the failure-compensation write.
 * @throws The channel's `enqueueFailedErrorCode` http error if enqueueing
 *   fails; the underlying job row is marked `failed` first so the org's
 *   active-job slot isn't permanently stranded.
 */
async function enqueueWithCompensation(
  job: JobRecord,
  wasCreated: boolean,
  opts: SubmitCampaignJobOptions,
  req: FastifyRequest,
  store: ReturnType<typeof getCampaignJobStore>,
): Promise<void> {
  // Enqueue on first creation, and ALSO on a replay whose job is still
  // `queued` — that means a previous enqueue never landed, and returning 202
  // again without re-queuing would promise a dispatch that never runs.
  // BullMQ de-duplicates on jobId, so a redundant add is a no-op.
  const needsEnqueue = wasCreated || job.status === 'queued';
  if (!needsEnqueue) return;

  try {
    await enqueueCampaignProcess({ jobId: job.id }, { attempts: opts.attempts });
  } catch (cause) {
    // The row is already committed. Leaving it `queued` strands it: the
    // watchdog only reaps `processing`, and `queued` counts against the
    // per-org active cap, so repeated Redis blips would permanently wedge
    // the org's cap. Mark it failed so the state is truthful and the slot
    // is released.
    const reason = cause instanceof Error ? cause.message : opts.enqueueFailedFallbackMessage;
    const marked = await store.setJobStatus(job.id, 'failed', 'enqueue_failed');
    if (!marked.ok) {
      req.log.error({
        operation: opts.logOperation,
        status: 'failure',
        job_id: job.id,
        error: 'could not mark the un-enqueued job failed',
      });
    }
    throw httpError(opts.enqueueFailedErrorCode, { detail: reason });
  }
}

/** Reads the `Idempotency-Key` request header (Fastify lowercases header names). */
function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}
