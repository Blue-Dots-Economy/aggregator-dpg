/**
 * Fail-closed Redis egress gate bounding our outbound call rate against a
 * voice provider's own rate limit (Raya's ~1 call/20s create/start budget).
 *
 * Fixed-window `INCR`+`EXPIRE` on `raya:egress:{windowStart}`, mirroring the
 * shape of the API's public-submit rate limiter
 * (`apps/api/src/services/rate-limiter`) — but with the opposite failure
 * posture. The API limiter fails OPEN on a Redis error because it protects
 * our own endpoint and a false negative there just means one extra request
 * gets through. This gate protects a call budget on someone else's
 * infrastructure: if we can't verify we're under the limit, guessing wrong
 * risks the provider throttling or banning the whole batch. So on a Redis
 * error it fails CLOSED — it sleeps out one full window and then lets the
 * caller proceed, trading a fixed worst-case delay for never bursting past
 * the provider's limit while Redis is unavailable.
 *
 * `redis`, `sleep`, and `now` are all injectable so the gate is unit
 * testable without a real Redis connection or real wall-clock waits.
 *
 * @module @aggregator-dpg/voice-provider
 */

import type { Redis } from 'ioredis';

/**
 * Dependencies for {@link acquireRayaSlot}.
 */
export interface AcquireRayaSlotDeps {
  /** Redis client used for the fixed-window counter. */
  redis: Redis;
  /** Window length in seconds (Raya's budget is expressed per this window). */
  windowSeconds: number;
  /** Maximum calls allowed per window. */
  max: number;
  /** Sleep function; defaults to a real `setTimeout`-backed wait. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock function; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
}

/**
 * Waits (if necessary) for a free slot under the provider's egress budget,
 * then returns. Callers must call this immediately before each Raya
 * create/start call.
 *
 * On each attempt this increments the counter for the current fixed window
 * and re-applies the window's TTL. If the resulting count is within `max`,
 * the slot is considered acquired and the function returns. Otherwise it
 * sleeps until the next window boundary and retries.
 *
 * Fail-closed: if the Redis call itself errors (connection down, timeout),
 * OR `multi().exec()` resolves but the `INCR` result is missing, carries a
 * per-command error tuple (ioredis resolves — never rejects — a pipelined
 * command failure as `[Error, null]`), or isn't a number, the function
 * cannot verify the current count, so it sleeps a full `windowSeconds *
 * 1000` ms and then returns — proceeding without further retry. This bounds
 * the caller's wait to one window even while Redis is unavailable or
 * degraded, while never letting an unverifiable count burst past the
 * provider's limit (an unverifiable result must never default to `count =
 * 0`, which would grant an immediate slot instead of failing closed).
 *
 * @param deps - Redis client, window/max budget, and injectable sleep/clock.
 */
export async function acquireRayaSlot(deps: AcquireRayaSlotDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  for (;;) {
    const nowMs = now();
    const windowStart = Math.floor(nowMs / 1000 / deps.windowSeconds) * deps.windowSeconds;
    const key = `raya:egress:${windowStart}`;

    let count: number;
    try {
      // INCR + EXPIRE issued atomically via multi(), matching the API rate
      // limiter's pipelining rationale — avoids the INCR-without-EXPIRE gap
      // that would otherwise leave a stale counter if the process died
      // between the two calls.
      const execResult = await deps.redis
        .multi()
        .incr(key)
        .expire(key, deps.windowSeconds + 1)
        .exec();
      const incrEntry = execResult?.[0];
      const incrError = Array.isArray(incrEntry) ? incrEntry[0] : undefined;
      const incrValue = Array.isArray(incrEntry) ? incrEntry[1] : undefined;
      // `multi().exec()` RESOLVES (never rejects) even when a pipelined
      // command itself failed (e.g. READONLY/OOM) — the failure surfaces as
      // an `[Error, null]` tuple, not a thrown exception. A missing result,
      // a missing/error'd INCR entry, or a non-numeric reply is exactly as
      // unverifiable as a thrown Redis error — fail closed the same way
      // rather than falling back to `count = 0` (an immediate grant).
      if (incrError != null || typeof incrValue !== 'number') {
        await sleep(deps.windowSeconds * 1000);
        return;
      }
      count = incrValue;
    } catch {
      // Fail closed: we cannot verify the window's count, so wait out one
      // full window before letting the caller proceed rather than risk
      // bursting past the provider's rate limit.
      await sleep(deps.windowSeconds * 1000);
      return;
    }

    if (count <= deps.max) return;

    const nowSeconds = Math.floor(nowMs / 1000);
    const waitMs = Math.max(0, (windowStart + deps.windowSeconds - nowSeconds) * 1000);
    await sleep(waitMs);
    // Loop back and re-check — by the next iteration's `now()` we should be
    // in a fresh window with a reset counter.
  }
}

/**
 * Default sleep implementation — a real `setTimeout`-backed wait, used when
 * no `sleep` dependency is injected (i.e. outside of tests).
 *
 * @param ms - Milliseconds to wait.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
