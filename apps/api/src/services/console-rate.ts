/**
 * Per-actor rate limit for console writes (`@aggregator-dpg/api`, user & org
 * Phase 5, design R11).
 *
 * Decisions and edits from `/v1/user/*` and `/v1/org/*` share one budget per
 * admin (`CONSOLE_WRITE_RATE_*`). Fail-open: a coarse guard against a runaway
 * client, not an anti-abuse control (the invite limit stays the fail-closed one).
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

/** Verdict of {@link checkConsoleWriteRate}. */
export interface ConsoleRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (actorId: string) => Promise<ConsoleRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker (null restores the Redis default). */
export function _setConsoleWriteRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one console write for the actor.
 *
 * @param actorId - The acting admin's `users.id`.
 * @returns Whether the write may proceed, and when to retry.
 */
export async function checkConsoleWriteRate(actorId: string): Promise<ConsoleRateResult> {
  if (override) return override(actorId);
  const r = await consume({
    namespace: 'console-write',
    key: actorId,
    windowSeconds: config.CONSOLE_WRITE_RATE_WINDOW_SECONDS,
    max: config.CONSOLE_WRITE_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
