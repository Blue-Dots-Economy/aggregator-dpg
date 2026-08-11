/**
 * BullMQ enqueue surface for the campaign PII export (aggregator-dpg#579).
 *
 * The API only validates + enqueues; the export itself runs in `apps/worker`'s
 * `export` role. Connection + queue are lazy singletons, mirroring
 * `services/bulk-queue`. Unlike bulk-upload there is no `jobId` dedup — repeated
 * requests are intentionally distinct exports. Belongs to `@aggregator-dpg/api`.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  createRedisConnection,
  type CampaignExportJob,
} from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let connection: Redis | null = null;
let exportQueue: Queue<CampaignExportJob> | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({ operation: 'campaignExportQueue.redis.error', error: err.message });
  });
  return connection;
}

function getExportQueue(): Queue<CampaignExportJob> {
  if (exportQueue) return exportQueue;
  exportQueue = new Queue<CampaignExportJob>(QueueName.CampaignExport, {
    connection: getConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return exportQueue;
}

/**
 * Enqueues a `campaign-export` job. Throws on enqueue failure (e.g. Redis
 * unreachable) so the route can surface a 503 rather than acknowledge a request
 * that was never durably queued.
 *
 * @param payload - The export job payload (org id, item ids, purpose, request id).
 */
export async function enqueueCampaignExport(payload: CampaignExportJob): Promise<void> {
  const start = Date.now();
  try {
    await getExportQueue().add(QueueName.CampaignExport, payload);
    logger.info({
      operation: 'campaignExportQueue.enqueue',
      status: 'success',
      latency_ms: Date.now() - start,
      org_id: payload.orgId,
      requested: payload.itemIds.length,
    });
  } catch (err) {
    logger.error({
      operation: 'campaignExportQueue.enqueue',
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
export async function closeCampaignExportQueue(): Promise<void> {
  await exportQueue?.close();
  await connection?.quit().catch(() => undefined);
  exportQueue = null;
  connection = null;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetCampaignExportQueue(): Promise<void> {
  await closeCampaignExportQueue();
}
