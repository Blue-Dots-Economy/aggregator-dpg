/**
 * Redis-backed idempotency dedup for outcome events.
 *
 * Uses `SET key 1 EX <ttl> NX` which atomically sets the key only when
 * absent. Returns 'first' on the initial sighting, 'duplicate' on every
 * subsequent see within the TTL window. On Redis failure, returns
 * 'unavailable' — the receiver should fail-open per design §12.3.
 *
 * @module idempotency
 * @package @aggregator-dpg/observability-svc
 */

import type { Redis } from 'ioredis';

/** Result codes returned by {@link IdempotencyStore.see}. */
export type SeenResult = 'first' | 'duplicate' | 'unavailable';

/**
 * Deduplicates inbound outcome events using Redis `SET NX`.
 *
 * Keys are namespaced under `obs:idem:` and expire after the configured
 * retention period so storage remains bounded.
 */
export class IdempotencyStore {
  private readonly ttlSec: number;

  /**
   * Creates a new IdempotencyStore.
   *
   * @param redis - Connected ioredis client (or compatible mock for tests).
   * @param retentionDays - How many days to retain seen keys before expiry.
   */
  constructor(
    private readonly redis: Redis,
    retentionDays: number,
  ) {
    this.ttlSec = retentionDays * 24 * 60 * 60;
  }

  /**
   * Records the first sighting of an idempotency key and detects duplicates.
   *
   * @param key - Unique event identifier (e.g. a UUID from the producer).
   * @returns
   *   - `'first'`       — key not previously seen; event should be processed.
   *   - `'duplicate'`   — key already present within the retention window; event should be dropped.
   *   - `'unavailable'` — Redis is unreachable; caller should fail-open.
   */
  async see(key: string): Promise<SeenResult> {
    const redisKey = `obs:idem:${key}`;
    try {
      const set = await this.redis.set(redisKey, '1', 'EX', this.ttlSec, 'NX');
      return set === 'OK' ? 'first' : 'duplicate';
    } catch {
      return 'unavailable';
    }
  }
}
