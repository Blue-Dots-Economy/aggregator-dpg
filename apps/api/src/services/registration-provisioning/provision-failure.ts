/**
 * Shared failure handler for all `ensure-*` provisioning executors.
 *
 * Centralises the attempt-bump + dead-letter logic so each executor does not
 * duplicate it. Callers pass their current `reg` snapshot (to read the current
 * attempt count) and receive a consistent `{ ok: false, error }` result.
 */

import { logger } from '../../logger.js';
import type {
  ProvisionKey,
  Registration,
  RegistrationStoreBase,
} from '../registration-store/interface.js';
import type { EnsureResult } from './index.js';

/**
 * Records a provisioning step failure and applies dead-letter logic.
 *
 * Bumps the attempt counter for `key` via `markProjection({ bumpAttempt: true })`.
 * When `attempts + 1 >= maxAttempts` the step is marked `'dead'` and the
 * reconciler will skip it; otherwise it is marked `'failed'` so the reconciler
 * retries on the next tick.
 *
 * @param op - Operation name included in the structured log entry.
 * @param reg - Current registration snapshot — read to determine the current attempt count.
 * @param key - Provision step key that failed.
 * @param error - Human-readable error string written to the log.
 * @param store - Registration store used to write the failure marker.
 * @param maxAttempts - Dead-letter threshold; read from `config.REGISTRATION_MAX_PROVISION_ATTEMPTS`.
 * @param start - `Date.now()` captured at executor entry, used to compute `latency_ms`.
 * @returns Always `{ ok: false, error }`.
 */
export async function handleProvisionFailure(
  op: string,
  reg: Registration,
  key: ProvisionKey,
  error: string,
  store: RegistrationStoreBase,
  maxAttempts: number,
  start: number,
): Promise<EnsureResult> {
  const currentAttempts = reg.provisionAttempts[key]?.attempts ?? 0;
  const nextAttempts = currentAttempts + 1;
  const isDead = nextAttempts >= maxAttempts;

  logger.error({
    operation: op,
    status: 'failure',
    registration_id: reg.id,
    provision_key: key,
    error,
    attempt: nextAttempts,
    dead: isDead,
    latency_ms: Date.now() - start,
  });

  await store.markProjection(reg.id, key, isDead ? 'dead' : 'failed', { bumpAttempt: true });
  return { ok: false, error };
}
