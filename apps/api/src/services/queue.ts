/**
 * BullMQ outbound-dispatch queue handle for the api process.
 *
 * Exposes a singleton {@link Queue} bound to {@link OUTBOUND_DISPATCH_QUEUE}.
 * The worker (apps/worker) drains it; the api only enqueues. Mirrors the
 * lazy-singleton + test-override pattern used by `services/bulk-queue` and
 * `services/signalstack` so route tests can inject a fake without spinning
 * up a real Redis connection.
 *
 * Kept narrow on purpose: only the dispatcher path needs this queue today.
 * If additional cross-app queues land on the api side, follow this shape
 * (one getter + one `_set*` test override per queue) rather than letting
 * a single helper sprawl across queue names.
 */

import { Queue } from 'bullmq';
import {
  DEFAULT_JOB_OPTS,
  OUTBOUND_DISPATCH_QUEUE,
  createRedisConnection,
  type OutboundDispatchJobData,
} from '@aggregator-dpg/queue';
import type { JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Minimal shape the route handler relies on. Kept narrower than the full
 * BullMQ `Queue` API so test fakes (`{ add: vi.fn() }`) satisfy it without
 * implementing close/getJobs/etc.
 */
export interface OutboundDispatchQueue {
  add(
    name: string,
    data: OutboundDispatchJobData,
    opts?: JobsOptions,
  ): Promise<{ id?: string | undefined }>;
}

let connection: Redis | null = null;
let outboundDispatchQueue: OutboundDispatchQueue | null = null;

function getConnection(): Redis {
  if (connection) return connection;
  connection = createRedisConnection({ url: config.REDIS_URL });
  connection.on('error', (err) => {
    logger.warn({
      operation: 'outboundDispatchQueue.redis.error',
      error: err.message,
    });
  });
  return connection;
}

/**
 * Returns the singleton BullMQ queue used to fan out completion dispatches.
 * Lazy-instantiates the underlying queue + Redis connection on first call.
 */
export function getOutboundDispatchQueue(): OutboundDispatchQueue {
  if (outboundDispatchQueue) return outboundDispatchQueue;
  outboundDispatchQueue = new Queue<OutboundDispatchJobData>(OUTBOUND_DISPATCH_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  return outboundDispatchQueue;
}

/**
 * Test-only override. Pass `null` to clear and force re-init on the next
 * {@link getOutboundDispatchQueue} call.
 */
export function _setOutboundDispatchQueue(q: OutboundDispatchQueue | null): void {
  outboundDispatchQueue = q;
}

/** Test-only — disconnect and clear cached singletons. */
export async function _resetOutboundDispatchQueue(): Promise<void> {
  if (outboundDispatchQueue && 'close' in outboundDispatchQueue) {
    await (outboundDispatchQueue as Queue).close();
  }
  await connection?.quit().catch(() => undefined);
  outboundDispatchQueue = null;
  connection = null;
}
