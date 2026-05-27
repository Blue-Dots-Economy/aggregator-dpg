/**
 * Worker entrypoint.
 *
 * Boots telemetry FIRST so OTel can patch BullMQ + undici + pg before
 * they enter the module cache. ESM static imports are hoisted, so any
 * module that loads BullMQ statically would race the OTel patches and
 * skip auto-instrumentation. Dynamic imports after bootWorkerTelemetry()
 * guarantee patches install first.
 *
 * @module apps/worker/main
 */

import { bootWorkerTelemetry, shutdownWorkerTelemetry, jobDurationMs } from './telemetry.js';
import type {
  BulkFileProcessJob,
  BulkFinaliseJob,
  BulkRowProcessJob,
  CronWatchdogJob,
  LinkMetricsRollupJob,
} from '@aggregator-dpg/queue';

await bootWorkerTelemetry();

// Dynamic value imports — must come AFTER bootWorkerTelemetry() so OTel's
// instrumentation patches install before BullMQ / pg / undici are loaded.
// (Type-only `import type` above is erased at compile time, so it does
// not cause runtime loading of the module's value graph.)
const { Queue, Worker } = await import('bullmq');
const queuePkg = await import('@aggregator-dpg/queue');
const { QueueName, DEFAULT_JOB_OPTS } = queuePkg;
const { wrapWorker } = await import('@aggregator-dpg/telemetry');
const { config } = await import('./config.js');
const { logger } = await import('./logger.js');
const { closeDb } = await import('./db.js');
const { processBulkFile } = await import('./jobs/bulk-file-process.js');
const { processBulkRow } = await import('./jobs/bulk-row-process.js');
const { finaliseBulk } = await import('./jobs/bulk-finalise.js');
const { rollupLinkMetrics } = await import('./jobs/link-metrics-rollup.js');
const { runWatchdog } = await import('./jobs/cron-watchdog.js');
const { getRedis, closeRedis } = await import('./services/redis.js');
const { closeQueues } = await import('./services/bulk-queue.js');

async function main(): Promise<void> {
  const connection = getRedis();

  const fileWorker = new Worker<BulkFileProcessJob>(
    QueueName.BulkFileProcess,
    async (job) => {
      const start = Date.now();
      try {
        return await wrapWorker(QueueName.BulkFileProcess, job.data, () =>
          processBulkFile(job.data),
        );
      } finally {
        jobDurationMs.record(Date.now() - start, { queue: QueueName.BulkFileProcess });
      }
    },
    {
      connection,
      concurrency: config.BULK_FILE_PROCESS_CONCURRENCY,
    },
  );

  const rowWorker = new Worker<BulkRowProcessJob>(
    QueueName.BulkRowProcess,
    async (job) => {
      const start = Date.now();
      try {
        return await wrapWorker(QueueName.BulkRowProcess, job.data, () => processBulkRow(job.data));
      } finally {
        jobDurationMs.record(Date.now() - start, { queue: QueueName.BulkRowProcess });
      }
    },
    {
      connection,
      concurrency: config.BULK_ROW_PROCESS_CONCURRENCY,
    },
  );

  const finaliseWorker = new Worker<BulkFinaliseJob>(
    QueueName.BulkFinalise,
    async (job) => {
      const start = Date.now();
      try {
        return await wrapWorker(QueueName.BulkFinalise, job.data, () => finaliseBulk(job.data));
      } finally {
        jobDurationMs.record(Date.now() - start, { queue: QueueName.BulkFinalise });
      }
    },
    {
      connection,
      concurrency: config.BULK_FINALISE_CONCURRENCY,
    },
  );

  const linkMetricsWorker = new Worker<LinkMetricsRollupJob>(
    QueueName.LinkMetricsRollup,
    async (job) => {
      const start = Date.now();
      try {
        return await wrapWorker(QueueName.LinkMetricsRollup, job.data, () =>
          rollupLinkMetrics(job.data),
        );
      } finally {
        jobDurationMs.record(Date.now() - start, { queue: QueueName.LinkMetricsRollup });
      }
    },
    {
      connection,
      concurrency: 1,
    },
  );

  const watchdogWorker = new Worker<CronWatchdogJob>(
    QueueName.CronWatchdog,
    async (job) => {
      const start = Date.now();
      try {
        return await wrapWorker(QueueName.CronWatchdog, job.data, () => runWatchdog());
      } finally {
        jobDurationMs.record(Date.now() - start, { queue: QueueName.CronWatchdog });
      }
    },
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
    await shutdownWorkerTelemetry();
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
