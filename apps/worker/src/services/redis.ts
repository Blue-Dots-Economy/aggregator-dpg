/**
 * Singleton ioredis connection for the worker process. Used by both BullMQ
 * Worker(s) and direct Lua-script calls.
 */

import { createRedisConnection } from '@aggregator-dpg/queue';
import type { Redis } from 'ioredis';
import { config } from '../config.js';

let instance: Redis | null = null;

export function getRedis(): Redis {
  if (instance) return instance;
  instance = createRedisConnection({ url: config.REDIS_URL });
  return instance;
}

export async function closeRedis(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
