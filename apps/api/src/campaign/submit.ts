/**
 * Shared persist-and-enqueue step for the campaign channels (#578, #579).
 *
 * Every channel's submit route ends the same way: in one transaction write a
 * `campaign_job` plus its item rows, then enqueue exactly one
 * `campaign-process` job. Only the channel name, the `content` block, the retry
 * count and the 503 code differ, so that tail lives here rather than being
 * copied per route — voice (#577) is the third caller.
 *
 * The failure handling is the non-obvious part and the reason this must not be
 * re-implemented per channel: the job row is committed before the enqueue, so a
 * failed enqueue has to mark the row `failed` or it sits `queued` forever,
 * counting against the org's active-job cap that nothing will ever release.
 *
 * @module @aggregator-dpg/api
 */
import type { FastifyRequest } from 'fastify';
import type {
  CampaignChannel,
  CampaignJobStoreBase,
  CampaignMetadataPair,
} from '../services/campaign-job-store/interface.js';
import { enqueueCampaignProcess } from '../services/campaign-process-queue/index.js';
import { httpError } from '../errors/http-error.js';
import type { ErrorCode } from '../errors/codes.js';

export interface SubmitCampaignJobInput {
  /** The inbound request — supplies the request id and the logger. */
  req: FastifyRequest;
  store: CampaignJobStoreBase;
  channel: CampaignChannel;
  aggregatorId: string;
  signalstackOrgId: string;
  /** De-duplicated target item ids, already capped by the route. */
  itemIds: string[];
  metadata: CampaignMetadataPair[];
  /** The channel's validated `content` block, stored verbatim on the job. */
  content: Record<string, unknown>;
  /** Server-set; never taken from the request body. */
  requestedBy: string;
  /** `Idempotency-Key` header value, when the caller sent one. */
  idempotencyKey?: string;
  /** BullMQ attempts for this channel (`CAMPAIGN_<CHANNEL>_ATTEMPTS`). */
  attempts: number;
  /** The channel's 503 catalogue code, thrown when the enqueue fails. */
  enqueueErrorCode: ErrorCode;
  /**
   * Per-item `action`, which is what the item-level active-dedup predicate keys
   * on. `null` (the default) keeps the channel out of dedup entirely — correct
   * for export and email; voice passes its action.
   */
  action?: string | null;
}

/**
 * Persists a campaign job and enqueues it for the worker.
 *
 * @param input - Channel, target items, content, and the channel's retry count
 *   and enqueue-failure code.
 * @returns The durable `campaign_job.id` to return in the 202.
 * @throws `INTERNAL` when the job cannot be written, or the channel's
 *   `<CHANNEL>_ENQUEUE_FAILED` when it cannot be queued.
 */
export async function submitCampaignJob(input: SubmitCampaignJobInput): Promise<string> {
  const { req, store, channel } = input;

  const created = await store.createJob({
    aggregatorId: input.aggregatorId,
    signalstackOrgId: input.signalstackOrgId,
    channel,
    metadata: input.metadata,
    content: input.content,
    requestedBy: input.requestedBy,
    requestId: req.id,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    items: input.itemIds.map((id) => ({ itemId: id, action: input.action ?? null })),
  });
  if (!created.ok) throw httpError('INTERNAL', { detail: 'could not create campaign job' });

  const jobId = created.value.job.id;

  // Enqueue on first creation, and ALSO on a replay whose job is still
  // `queued` — that means a previous enqueue never landed, and returning 202
  // again without re-queuing would promise work that never runs. BullMQ
  // de-duplicates on jobId, so a redundant add is a no-op.
  if (created.value.created || created.value.job.status === 'queued') {
    await enqueueOrFailJob(input, jobId);
  }

  return jobId;
}

/**
 * Enqueues the job, and on failure marks the committed row `failed` before
 * surfacing the channel's 503 — see the module note on why the row must not be
 * left `queued`.
 */
async function enqueueOrFailJob(input: SubmitCampaignJobInput, jobId: string): Promise<void> {
  try {
    await enqueueCampaignProcess({ jobId }, { attempts: input.attempts });
  } catch (cause) {
    const reason =
      cause instanceof Error ? cause.message : `failed to enqueue ${input.channel} job`;
    const marked = await input.store.setJobStatus(jobId, 'failed', 'enqueue_failed');
    if (!marked.ok) {
      input.req.log.error({
        operation: `campaign.${input.channel}.enqueue`,
        status: 'failure',
        job_id: jobId,
        error: 'could not mark the un-enqueued job failed',
      });
    }
    throw httpError(input.enqueueErrorCode, { detail: reason });
  }
}

/** Reads the `Idempotency-Key` request header (Fastify lowercases header names). */
export function readIdempotencyKey(req: FastifyRequest): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || undefined;
}
