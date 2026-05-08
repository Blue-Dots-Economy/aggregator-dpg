/**
 * Worker entrypoint.
 *
 * Wires BullMQ workers for the onboarding pipeline. At slice 9 this
 * exposes only the File Processor (`bulk-file-process` queue). Subsequent
 * slices add the Row Processor, Finaliser, and Metrics Aggregator workers
 * alongside.
 */

import { Worker } from 'bullmq';
import { QueueName, type BulkFileProcessJob, type BulkRowProcessJob } from '@aggregator-dpg/queue';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db.js';
import { processBulkFile } from './jobs/bulk-file-process.js';
import { processBulkRow } from './jobs/bulk-row-process.js';
import { getRedis, closeRedis } from './services/redis.js';
import { closeQueues } from './services/bulk-queue.js';

async function main(): Promise<void> {
  const connection = getRedis();

  const fileWorker = new Worker<BulkFileProcessJob>(
    QueueName.BulkFileProcess,
    async (job) => processBulkFile(job.data),
    {
      connection,
      concurrency: config.BULK_FILE_PROCESS_CONCURRENCY,
    },
  );

  const rowWorker = new Worker<BulkRowProcessJob>(
    QueueName.BulkRowProcess,
    async (job) => processBulkRow(job.data),
    {
      connection,
      concurrency: config.BULK_ROW_PROCESS_CONCURRENCY,
    },
  );

  for (const [name, w] of [
    ['bulkFileProcess', fileWorker],
    ['bulkRowProcess', rowWorker],
  ] as const) {
    w.on('completed', (job, result) => {
      logger.debug({
        operation: `worker.${name}.completed`,
        job_id: job.id,
        result,
      });
    });
    w.on('failed', (job, err) => {
      logger.error({
        operation: `worker.${name}.failed`,
        job_id: job?.id,
        error: err.message,
      });
    });
  }

  logger.info({
    operation: 'worker.boot',
    status: 'ready',
    queues: [QueueName.BulkFileProcess, QueueName.BulkRowProcess],
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ operation: 'worker.shutdown', signal });
    await Promise.all([fileWorker.close(), rowWorker.close()]);
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({
    operation: 'worker.boot',
    status: 'failure',
    error: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});
