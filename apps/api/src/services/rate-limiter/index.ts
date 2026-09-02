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
  // Dedicated fail-fast connection — NOT the BullMQ profile. The rate
  // limiter fails open on Redis errors (see consume), so a downed Redis must
  // surface an error promptly rather than buffering commands forever. A
  // finite per-request retry + command timeout + disabled offline queue make
  // the catch-and-allow path fire within ~1s instead of hanging the public
  // submit endpoint.
  instance = createRedisConnection({
    url: config.REDIS_URL,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    enableOfflineQueue: false,
  });
  // ioredis emits 'error' on every reconnect attempt; without a listener
  // those bubble as unhandled. Swallow here — consume's try/catch owns the
  // request-path behaviour (fail open).
  instance.on('error', () => undefined);
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
  /**
   * Slots this call consumes. Default 1. A bulk operation (e.g. minting N
   * invites in one request) passes N so the window bounds total events, not
   * request count.
   */
  cost?: number;
  /**
   * On a Redis error, deny instead of the default allow. Use for anti-abuse
   * controls where a downed Redis must NOT silently remove the limit (e.g. the
   * invite-mint bucket — a leaked grant would otherwise become unbounded). The
   * public-submit limiter keeps the default fail-open posture.
   */
  failClosed?: boolean;
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
    const cost = Math.max(1, Math.floor(options.cost ?? 1));
    const pipelineRes = await redis
      .multi()
      .incrby(fullKey, cost)
      .expire(fullKey, options.windowSeconds + 1)
      .exec();
    const incrEntry = pipelineRes?.[0];
    const count = Array.isArray(incrEntry) && typeof incrEntry[1] === 'number' ? incrEntry[1] : 0;
    if (count > options.max) {
      // Refund the slots this denied call just consumed so a rejected request
      // (e.g. an over-cap bulk mint) doesn't poison the window and lock out
      // later smaller requests. Best-effort — a failed refund only over-counts.
      await redis.decrby(fullKey, cost).catch(() => undefined);
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
      fail_closed: options.failClosed ?? false,
    });
    // Default: fail open on Redis blips (public submit — better to accept
    // traffic than 5xx). Anti-abuse callers set failClosed so a downed Redis
    // can't silently remove the limit.
    if (options.failClosed) {
      return { allowed: false, count: 0, retryAfterSeconds: options.windowSeconds };
    }
    return { allowed: true, count: 0, retryAfterSeconds: 0 };
  }
}

export async function closeRateLimiter(): Promise<void> {
  await instance?.quit().catch(() => undefined);
  instance = null;
}
