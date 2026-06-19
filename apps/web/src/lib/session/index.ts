/**
 * Session store factory.
 *
 * Picks an implementation based on env:
 *   - `REDIS_URL` set → `RedisSessionStore` (production / docker-compose dev)
 *   - otherwise → `MemorySessionStore` (unit tests, offline dev)
 *
 * Returns a process-wide singleton so callers share one connection.
 */

import { MemorySessionStore } from './memory';
import { RedisSessionStore } from './redis';
import { type SessionStoreBase } from './interface';

let instance: SessionStoreBase | null = null;

/**
 * Returns the shared session store instance.
 *
 * @returns Active `SessionStoreBase` implementation.
 */
export function getSessionStore(): SessionStoreBase {
  if (instance) return instance;
  const ttlSec = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12);
  instance = process.env.REDIS_URL
    ? new RedisSessionStore({ ttlSec })
    : new MemorySessionStore({ ttlSec });
  return instance;
}

/**
 * Test-only helper to reset the singleton between suites.
 */
export function _resetSessionStore(): void {
  instance = null;
}

export { SessionStoreBase } from './interface';
export type { SessionData, SessionResult, SessionError } from './interface';
