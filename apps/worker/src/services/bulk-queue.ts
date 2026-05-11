/**
 * Worker-side enqueue surfaces.
 *
 * Reader → enqueue per-row jobs (File Processor uses this).
 * Row Processor → enqueue Finaliser job on the last row.
 */

import { Queue } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkRowProcessJob,
  type BulkFinaliseJob,
} from '@aggregator-dpg/queue';
import { getRedis } from './redis.js';
import { logger } from '../logger.js';

let rowQueue: Queue<BulkRowProcessJob> | null = null;
let finaliseQueue: Queue<BulkFinaliseJob> | null = null;

function getRowQueue(): Queue<BulkRowProcessJob> {
  if (rowQueue) return rowQueue;
  rowQueue = new Queue<BulkRowProcessJob>(QueueName.BulkRowProcess, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return rowQueue;
}

function getFinaliseQueue(): Queue<BulkFinaliseJob> {
  if (finaliseQueue) return finaliseQueue;
  finaliseQueue = new Queue<BulkFinaliseJob>(QueueName.BulkFinalise, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return finaliseQueue;
}

/**
 * Enqueue a per-row job. jobId encodes (uploadId, rowIndex) for replay
 * safety. BullMQ rejects ':' in custom jobIds — use '__' as the separator.
 */
export async function enqueueRowProcess(payload: BulkRowProcessJob): Promise<void> {
  await getRowQueue().add(QueueName.BulkRowProcess, payload, {
    jobId: `${payload.uploadId}__${payload.rowIndex}`,
  });
}

/**
 * Batch-enqueue per-row jobs. Single `LPUSH+EVALSHA` BullMQ pipeline instead
 * of one round-trip per row — order is preserved and dedup `jobId` semantics
 * match `enqueueRowProcess`.
 */
export async function enqueueRowProcessBulk(payloads: BulkRowProcessJob[]): Promise<void> {
  if (payloads.length === 0) return;
  const queue = getRowQueue();
  await queue.addBulk(
    payloads.map((p) => ({
      name: QueueName.BulkRowProcess,
      data: p,
      opts: { jobId: `${p.uploadId}__${p.rowIndex}` },
    })),
  );
}

/**
 * Enqueue the Finaliser. jobId = `${uploadId}__finalise` so BullMQ
 * deduplicates if multiple Row Processors hit the equality condition
 * concurrently — only one finaliser ever runs.
 */
export async function enqueueFinalise(payload: BulkFinaliseJob): Promise<void> {
  await getFinaliseQueue().add(QueueName.BulkFinalise, payload, {
    jobId: `${payload.uploadId}__finalise`,
  });
  logger.info({
    operation: 'bulkQueue.enqueueFinalise',
    upload_id: payload.uploadId,
  });
}

export async function closeQueues(): Promise<void> {
  await rowQueue?.close();
  await finaliseQueue?.close();
  rowQueue = null;
  finaliseQueue = null;
}
