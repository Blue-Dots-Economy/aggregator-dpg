/**
 * BullMQ enqueue surface for the bulk-upload pipeline.
 *
 * The API only enqueues; consumption lives in `apps/worker`. Connection and
 * queue are lazy singletons owned by {@link createQueueClient}.
 */

import { QueueName, DEFAULT_JOB_OPTS, type BulkFileProcessJob } from '@aggregator-dpg/queue';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { createQueueClient } from '../queue-client.js';

const client = createQueueClient<BulkFileProcessJob>({
  name: QueueName.BulkFileProcess,
  url: config.REDIS_URL,
  defaultJobOptions: DEFAULT_JOB_OPTS,
  operation: 'bulkQueue',
});

/**
 * Enqueues a `bulk-file-process` job. Idempotent via `jobId = uploadId` —
 * a duplicate enqueue for the same upload is silently no-op.
 */
export async function enqueueBulkFileProcess(payload: BulkFileProcessJob): Promise<void> {
  const start = Date.now();
  try {
    await client.queue().add(QueueName.BulkFileProcess, payload, {
      jobId: payload.uploadId,
    });
    logger.info({
      operation: 'bulkQueue.enqueueBulkFileProcess',
      status: 'success',
      latency_ms: Date.now() - start,
      upload_id: payload.uploadId,
    });
  } catch (err) {
    logger.error({
      operation: 'bulkQueue.enqueueBulkFileProcess',
      status: 'failure',
      error: (err as Error).message,
      latency_ms: Date.now() - start,
      upload_id: payload.uploadId,
    });
    throw err;
  }
}

/**
 * Closes the BullMQ enqueue queue and its Redis connection. Idempotent; call
 * from process shutdown so the queue + connection are not leaked on SIGTERM.
 */
export async function closeBulkQueue(): Promise<void> {
  await client.close();
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetBulkQueue(): Promise<void> {
  await closeBulkQueue();
}
