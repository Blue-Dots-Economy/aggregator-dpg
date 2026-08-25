/**
 * BullMQ enqueue surface for the unified campaign-process pipeline (#579).
 *
 * The API validates + persists the `campaign_job` row, then enqueues a job
 * carrying only its id; the worker's `campaign` role loads the rest and runs
 * the per-channel handler. Connection + queue are lazy singletons, mirroring
 * `services/campaign-export-queue`. Belongs to `@aggregator-dpg/api`.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  CAMPAIGN_PROCESS_JOB_OPTS,
  createRedisConnection,
  type CampaignProcessJob,
} from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let connection: Redis | null = null;
let processQueue: Queue<CampaignProcessJob> | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({ operation: 'campaignProcessQueue.redis.error', error: err.message });
  });
  return connection;
}

function getProcessQueue(): Queue<CampaignProcessJob> {
  if (processQueue) return processQueue;
  processQueue = new Queue<CampaignProcessJob>(QueueName.CampaignProcess, {
    connection: getConnection(),
    // One queue, many channels: the retry count is a per-channel knob
    // (CAMPAIGN_<CHANNEL>_ATTEMPTS), so each route passes its own at enqueue
    // time and this default only applies if a caller omits it.
    defaultJobOptions: CAMPAIGN_PROCESS_JOB_OPTS,
  });
  return processQueue;
}

/**
 * Enqueues a `campaign-process` job. Uses the durable `campaign_job.id` as the
 * BullMQ jobId so a same-job re-enqueue (e.g. an idempotency replay that races)
 * is de-duplicated by BullMQ. Throws on enqueue failure so the route can
 * surface a 503 rather than acknowledge a job that was never queued.
 *
 * @param payload - `{ jobId }` — the campaign_job row to process.
 * @param opts - Per-channel overrides; `attempts` comes from the submitting
 *   channel's `CAMPAIGN_<CHANNEL>_ATTEMPTS`.
 */
export async function enqueueCampaignProcess(
  payload: CampaignProcessJob,
  opts: { attempts?: number } = {},
): Promise<void> {
  const start = Date.now();
  try {
    await getProcessQueue().add(QueueName.CampaignProcess, payload, {
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
  await processQueue?.close();
  await connection?.quit().catch(() => undefined);
  processQueue = null;
  connection = null;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetCampaignProcessQueue(): Promise<void> {
  await closeCampaignProcessQueue();
}
