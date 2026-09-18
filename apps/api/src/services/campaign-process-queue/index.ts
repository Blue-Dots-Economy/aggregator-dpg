/**
 * BullMQ enqueue surface for the unified campaign-process pipeline (#579).
 *
 * The API validates + persists the `campaign_job` row, then enqueues a job
 * carrying only its id; the worker's `campaign` role loads the rest and runs
 * the per-channel handler. Connection + queue are lazy singletons owned by
 * {@link createQueueClient}. Belongs to `@aggregator-dpg/api`.
 */

import {
  QueueName,
  CAMPAIGN_PROCESS_JOB_OPTS,
  type CampaignProcessJob,
} from '@aggregator-dpg/queue';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { createQueueClient } from '../queue-client.js';

// No `attempts` in the default job options: one queue serves every channel, so
// baking in the export knob would silently govern email and voice too. Callers
// pass their own CAMPAIGN_<CHANNEL>_ATTEMPTS per enqueue.
const client = createQueueClient<CampaignProcessJob>({
  name: QueueName.CampaignProcess,
  url: config.REDIS_URL,
  defaultJobOptions: CAMPAIGN_PROCESS_JOB_OPTS,
  operation: 'campaignProcessQueue',
});

/**
 * Enqueues a `campaign-process` job. Uses the durable `campaign_job.id` as the
 * BullMQ jobId so a same-job re-enqueue (e.g. an idempotency replay that races)
 * is de-duplicated by BullMQ. Throws on enqueue failure so the route can
 * surface a 503 rather than acknowledge a job that was never queued.
 *
 * @param payload - `{ jobId }` — the campaign_job row to process.
 * @param opts.attempts - Retry count for this channel
 *   (`CAMPAIGN_<CHANNEL>_ATTEMPTS`). Falls back to the shared default.
 */
export async function enqueueCampaignProcess(
  payload: CampaignProcessJob,
  opts: { attempts?: number } = {},
): Promise<void> {
  const start = Date.now();
  try {
    await client.queue().add(QueueName.CampaignProcess, payload, {
      jobId: payload.jobId,
      ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
    });
    logger.info({
      operation: 'campaignProcessQueue.enqueue',
      status: 'success',
      latency_ms: Date.now() - start,
      job_id: payload.jobId,
    });
  } catch (err) {
    logger.error({
      operation: 'campaignProcessQueue.enqueue',
      status: 'failure',
      error: (err as Error).message,
      latency_ms: Date.now() - start,
      job_id: payload.jobId,
    });
    throw err;
  }
}

/**
 * Closes the queue and its Redis connection. Idempotent; call from process
 * shutdown so the connection is not leaked on SIGTERM.
 */
export async function closeCampaignProcessQueue(): Promise<void> {
  await client.close();
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetCampaignProcessQueue(): Promise<void> {
  await closeCampaignProcessQueue();
}
