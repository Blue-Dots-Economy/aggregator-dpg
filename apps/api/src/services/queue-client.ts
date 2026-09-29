/**
 * Lazy BullMQ enqueue-side singleton: one Redis connection plus one `Queue`,
 * built on first use and cleared on close.
 *
 * `bulk-queue/` and `campaign-process-queue/` carried byte-identical copies of
 * this lifecycle. Their `enqueue` bodies genuinely differ — each derives its
 * own BullMQ `jobId` and logs its own operation — so only the
 * connection/queue/close third is shared here.
 *
 * Deliberately lives in `apps/api` rather than `@aggregator-dpg/queue`: that
 * package's module doc states BullMQ is intentionally not abstracted there
 * (API and worker construct their own `Queue` / `Worker` from its names and
 * types), and both consumers of this helper are API-side.
 *
 * @module @aggregator-dpg/api
 */

import { Queue, type JobsOptions } from 'bullmq';
import { createRedisConnection } from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

/** A lazily-built, cached BullMQ queue plus its shutdown hook. */
export interface QueueClient<T> {
  /** The queue — built together with its Redis connection on first call, then reused. */
  queue(): Queue<T>;
  /**
   * Closes the queue, quits the connection, and clears both so a later
   * `queue()` rebuilds from scratch. Idempotent, and a no-op when nothing was
   * ever built.
   */
  close(): Promise<void>;
}

/** Everything the enqueue side of one queue needs to know. */
export interface QueueClientOptions {
  /** Queue name — a `QueueName` constant from `@aggregator-dpg/queue`. */
  name: string;
  /** Redis URL for the dedicated enqueue connection. */
  url: string;
  /** BullMQ `defaultJobOptions` for this queue. */
  defaultJobOptions: JobsOptions;
  /**
   * Log-line `operation` prefix for the connection's error handler, e.g.
   * `bulkQueue` → `bulkQueue.redis.error`.
   */
  operation: string;
}

/**
 * Builds a {@link QueueClient} for one BullMQ queue.
 *
 * ioredis emits `error` on every reconnect attempt; the handler logs at warn
 * and swallows, because an enqueue failure surfaces through the `add()` call
 * the route already awaits.
 *
 * @typeParam T - The queue's job payload type.
 * @param opts - Queue name, Redis URL, default job options, log prefix.
 * @returns The lazy queue accessor + its close hook.
 */
export function createQueueClient<T>(opts: QueueClientOptions): QueueClient<T> {
  let connection: Redis | null = null;
  let queue: Queue<T> | null = null;

  return {
    queue(): Queue<T> {
      if (queue) return queue;
      connection = createRedisConnection({ url: opts.url });
      connection.on('error', (err) => {
        logger.warn({ operation: `${opts.operation}.redis.error`, error: err.message });
      });
      queue = new Queue<T>(opts.name, {
        connection,
        defaultJobOptions: opts.defaultJobOptions,
      });
      return queue;
    },

    async close(): Promise<void> {
      await queue?.close();
      await connection?.quit().catch(() => undefined);
      queue = null;
      connection = null;
    },
  };
}
