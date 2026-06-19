/**
 * Worker entrypoint.
 *
 * Wires BullMQ workers for the onboarding pipeline. At slice 9 this
 * exposes only the File Processor (`bulk-file-process` queue). Subsequent
 * slices add the Row Processor, Finaliser, and Metrics Aggregator workers
 * alongside.
 */

import { Queue, Worker } from 'bullmq';
import {
  QueueName,
  DEFAULT_JOB_OPTS,
  type BulkFileProcessJob,
  type BulkFinaliseJob,
  type BulkRowProcessJob,
  type CronWatchdogJob,
  type LinkMetricsRollupJob,
} from '@aggregator-dpg/queue';
import { config } from './config.js';
import { logger } from './logger.js';
import { closeDb } from './db.js';
import { processBulkFile } from './jobs/bulk-file-process.js';
import { processBulkRow } from './jobs/bulk-row-process.js';
import { finaliseBulk } from './jobs/bulk-finalise.js';
import { rollupLinkMetrics } from './jobs/link-metrics-rollup.js';
import { runWatchdog } from './jobs/cron-watchdog.js';
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

  const finaliseWorker = new Worker<BulkFinaliseJob>(
    QueueName.BulkFinalise,
    async (job) => finaliseBulk(job.data),
    {
      connection,
      concurrency: config.BULK_FINALISE_CONCURRENCY,
    },
  );

  const linkMetricsWorker = new Worker<LinkMetricsRollupJob>(
    QueueName.LinkMetricsRollup,
    async (job) => rollupLinkMetrics(job.data),
    {
      connection,
      concurrency: 1,
    },
  );

  const watchdogWorker = new Worker<CronWatchdogJob>(
    QueueName.CronWatchdog,
    async () => runWatchdog(),
    {
      connection,
      concurrency: 1,
    },
  );

  // Repeatable cron ticks. Threshold-triggered fan-in for metrics rollup
  // can be added later — cron-only is sufficient for MVP.
  const linkMetricsQueue = new Queue<LinkMetricsRollupJob>(QueueName.LinkMetricsRollup, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  await linkMetricsQueue.add(
    'tick',
    { tick: Date.now() },
    {
      repeat: { every: config.LINK_METRICS_ROLLUP_INTERVAL_MS },
      jobId: 'link-metrics-rollup-tick',
    },
  );

  const watchdogQueue = new Queue<CronWatchdogJob>(QueueName.CronWatchdog, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  await watchdogQueue.add(
    'tick',
    { tick: Date.now() },
    {
      repeat: { every: config.WATCHDOG_INTERVAL_MS },
      jobId: 'cron-watchdog-tick',
    },
  );

  // One-shot cleanup: removed cron-driven keycloak-sync. If a previous worker
  // run registered the repeatable, drop it from Redis so it does not keep
  // firing without a consumer.
  const legacyKeycloakSyncQueue = new Queue('keycloak-sync', { connection });
  try {
    const repeatables = await legacyKeycloakSyncQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await legacyKeycloakSyncQueue.removeRepeatableByKey(r.key);
    }
  } finally {
    await legacyKeycloakSyncQueue.close();
  }

  for (const [name, w] of [
    ['bulkFileProcess', fileWorker],
    ['bulkRowProcess', rowWorker],
    ['bulkFinalise', finaliseWorker],
    ['linkMetricsRollup', linkMetricsWorker],
    ['cronWatchdog', watchdogWorker],
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
    queues: [
      QueueName.BulkFileProcess,
      QueueName.BulkRowProcess,
      QueueName.BulkFinalise,
      QueueName.LinkMetricsRollup,
      QueueName.CronWatchdog,
    ],
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ operation: 'worker.shutdown', signal });
    await Promise.all([
      fileWorker.close(),
      rowWorker.close(),
      finaliseWorker.close(),
      linkMetricsWorker.close(),
      watchdogWorker.close(),
    ]);
    await Promise.all([linkMetricsQueue.close(), watchdogQueue.close()]);
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
