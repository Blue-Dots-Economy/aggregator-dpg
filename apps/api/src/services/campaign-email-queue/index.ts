/**
 * BullMQ enqueue surface for the campaign participant email (aggregator-dpg#578).
 *
 * The API only validates + enqueues; the send itself runs in `apps/worker`'s
 * `email` role. Connection + queue are lazy singletons, mirroring
 * `services/campaign-export-queue`. The queue uses {@link EMAIL_JOB_OPTS}
 * (`attempts: 1`) so a retry never re-sends to recipients who already received
 * the email. Belongs to `@aggregator-dpg/api`.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  EMAIL_JOB_OPTS,
  createRedisConnection,
  type CampaignEmailJob,
} from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let connection: Redis | null = null;
let emailQueue: Queue<CampaignEmailJob> | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({ operation: 'campaignEmailQueue.redis.error', error: err.message });
  });
  return connection;
}

function getEmailQueue(): Queue<CampaignEmailJob> {
  if (emailQueue) return emailQueue;
  emailQueue = new Queue<CampaignEmailJob>(QueueName.CampaignEmail, {
    connection: getConnection(),
    defaultJobOptions: EMAIL_JOB_OPTS,
  });
  return emailQueue;
}

/**
 * Enqueues a `campaign-email` job. Throws on enqueue failure (e.g. Redis
 * unreachable) so the route can surface a 503 rather than acknowledge a request
 * that was never durably queued.
 *
 * @param payload - The email job payload (org id, item ids, subject, body, etc.).
 */
export async function enqueueCampaignEmail(payload: CampaignEmailJob): Promise<void> {
  const start = Date.now();
  try {
    await getEmailQueue().add(QueueName.CampaignEmail, payload);
    logger.info({
      operation: 'campaignEmailQueue.enqueue',
      status: 'success',
      latency_ms: Date.now() - start,
      org_id: payload.orgId,
      requested: payload.itemIds.length,
    });
  } catch (err) {
    logger.error({
      operation: 'campaignEmailQueue.enqueue',
      status: 'failure',
      error: (err as Error).message,
      latency_ms: Date.now() - start,
      org_id: payload.orgId,
    });
    throw err;
  }
}

/**
 * Closes the queue and its Redis connection. Idempotent; call from process
 * shutdown so the connection is not leaked on SIGTERM.
 */
export async function closeCampaignEmailQueue(): Promise<void> {
  await emailQueue?.close();
  await connection?.quit().catch(() => undefined);
  emailQueue = null;
  connection = null;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetCampaignEmailQueue(): Promise<void> {
  await closeCampaignEmailQueue();
}
