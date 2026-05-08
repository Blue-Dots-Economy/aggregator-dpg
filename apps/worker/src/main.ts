/**
 * Worker entrypoint.
 *
 * Wires BullMQ workers for the onboarding pipeline. At slice 9 this
 * exposes only the File Processor (`bulk-file-process` queue). Subsequent
 * slices add the Row Processor, Finaliser, and Metrics Aggregator workers
 * alongside.
 */

import { Worker } from 'bullmq';
import { QueueName, createRedisConnection, type BulkFileProcessJob } from '@aggregator-dpg/queue';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db.js';
import { processBulkFile } from './jobs/bulk-file-process.js';

async function main(): Promise<void> {
  const connection = createRedisConnection({ url: config.REDIS_URL });

  const fileWorker = new Worker<BulkFileProcessJob>(
    QueueName.BulkFileProcess,
    async (job) => processBulkFile(job.data),
    {
      connection,
      concurrency: config.BULK_FILE_PROCESS_CONCURRENCY,
    },
  );

  fileWorker.on('completed', (job, result) => {
    logger.info({
      operation: 'worker.bulkFileProcess.completed',
      job_id: job.id,
      result,
    });
  });

  fileWorker.on('failed', (job, err) => {
    logger.error({
      operation: 'worker.bulkFileProcess.failed',
      job_id: job?.id,
      error: err.message,
    });
  });

  logger.info({
    operation: 'worker.boot',
    status: 'ready',
    queues: [QueueName.BulkFileProcess],
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ operation: 'worker.shutdown', signal });
    await fileWorker.close();
    await connection.quit().catch(() => undefined);
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
