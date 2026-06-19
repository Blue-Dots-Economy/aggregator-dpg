/**
 * Reusable ioredis client singleton.
 *
 * ioredis multiplexes commands on a single TCP connection, so one shared
 * client across the Node.js process is the idiomatic equivalent of a
 * connection pool. Avoid creating a new Redis instance per request — that
 * defeats keep-alive and exhausts file descriptors under load.
 *
 * The singleton:
 *   - Initialises lazily on first call to `getRedisClient()`.
 *   - Reconnects automatically (ioredis handles transient failures).
 *   - Exposes `closeRedisClient()` for graceful shutdown hooks.
 */

import Redis, { type RedisOptions } from 'ioredis';

let client: Redis | null = null;
let closing = false;

const DEFAULT_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  connectTimeout: 5000,
  keepAlive: 30000,
  // Retry on each disconnect with exponential backoff capped at 2s.
  retryStrategy(times: number): number {
    return Math.min(50 * 2 ** times, 2000);
  },
};

/**
 * Returns the shared Redis client, creating it on first use.
 *
 * @param url - Optional Redis URL. Falls back to `REDIS_URL` env var,
 *   then `redis://localhost:6379`.
 * @returns Shared ioredis instance with multiplexed connection.
 */
export function getRedisClient(url?: string): Redis {
  if (client && !closing) return client;
  if (closing) throw new Error('Redis client is shutting down');

  const target = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  client = new Redis(target, DEFAULT_OPTIONS);
  return client;
}

/**
 * Closes the shared Redis client. Idempotent.
 *
 * Call from process shutdown handlers (SIGINT/SIGTERM) so connections drain
 * cleanly. After close, subsequent `getRedisClient()` calls open a new client.
 */
export async function closeRedisClient(): Promise<void> {
  if (!client) return;
  closing = true;
  try {
    await client.quit();
  } finally {
    client = null;
    closing = false;
  }
}

/**
 * Test-only helper to inject a custom client. Resets the singleton.
 */
export function _setRedisClient(c: Redis | null): void {
  client = c;
}
