/**
 * Fixed-window rate limiter backed by Redis.
 *
 * Used to bound the public link-submission endpoint per (slug, ip). The
 * window is intentionally small and configurable via env so dev runs aren't
 * accidentally rate-limited.
 *
 * Key shape: `rl:{namespace}:{key}:{windowStart}` → INCR with EXPIRE.
 */

import type { Redis } from 'ioredis';
import { createRedisConnection } from '@aggregator-dpg/queue';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let instance: Redis | null = null;

function getRedis(): Redis {
  if (instance) return instance;
  instance = createRedisConnection({ url: config.REDIS_URL });
  return instance;
}

export interface RateLimitOptions {
  /** Logical bucket name (e.g. `link-submit`). */
  namespace: string;
  /** Identifier inside the bucket — typically slug, ip, or `${slug}:${ip}`. */
  key: string;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Maximum events allowed per window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/**
 * Tries to consume one slot from the rate-limit bucket. Returns whether the
 * call is allowed plus the current window count.
 */
export async function consume(options: RateLimitOptions): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Date.now();
  const windowStart = Math.floor(now / 1000 / options.windowSeconds) * options.windowSeconds;
  const fullKey = `rl:${options.namespace}:${options.key}:${windowStart}`;
  try {
    // INCR + EXPIRE issued atomically. Pipelining via `multi()` avoids the
    // INCR-without-EXPIRE window that exists if the process dies between
    // calls — without TTL the bucket would never reset. Re-applying
    // EXPIRE on every hit is a no-op cost-wise (single Redis op) and
    // keeps the key alive while traffic is active in-window.
    const pipelineRes = await redis
      .multi()
      .incr(fullKey)
      .expire(fullKey, options.windowSeconds + 1)
      .exec();
    const incrEntry = pipelineRes?.[0];
    const count = Array.isArray(incrEntry) && typeof incrEntry[1] === 'number' ? incrEntry[1] : 0;
    if (count > options.max) {
      const retryAfterSeconds = Math.max(
        1,
        windowStart + options.windowSeconds - Math.floor(now / 1000),
      );
      return { allowed: false, count, retryAfterSeconds };
    }
    return { allowed: true, count, retryAfterSeconds: 0 };
  } catch (err) {
    logger.warn({
      operation: 'rateLimiter.consume',
      status: 'failure',
      error: (err as Error).message,
      namespace: options.namespace,
    });
    // Fail open on Redis blips — better to accept traffic than to lock the
    // public endpoint behind an opaque 5xx.
    return { allowed: true, count: 0, retryAfterSeconds: 0 };
  }
}

export async function closeRateLimiter(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
