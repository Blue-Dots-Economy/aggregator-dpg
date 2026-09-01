/**
 * Rejection cooling-window helper (#726) for the aggregator-dpg API.
 *
 * A rejected coordinator or org registration cannot be re-submitted until a
 * configurable cooling window (`REGISTRATION_COOLING_MINUTES`, default 720 =
 * 12h) has elapsed. The window is measured from the write-once `rejected_at`
 * timestamp so it is immune to the mutable `updated_at` (which any later write
 * would move). Once the window lapses the caller revives the SAME row.
 */

import { config } from '../config.js';

/**
 * Computes the cooling-window verdict for a rejected registration row.
 *
 * @param rejectedAt - Write-once reject timestamp; falls back to `updatedAt`
 *   for rows rejected before migration 0022 stamped the column.
 * @param updatedAt - The row's last-updated timestamp (fallback reference).
 * @returns ISO retry-after timestamp while still cooling, or `null` once the
 *   window has elapsed and re-registration is permitted.
 */
export function coolingRetryAfter(rejectedAt: Date | null, updatedAt: Date): string | null {
  const rejectedRef = rejectedAt ?? updatedAt;
  const windowMs = config.REGISTRATION_COOLING_MINUTES * 60_000;
  const readyAt = rejectedRef.getTime() + windowMs;
  return Date.now() < readyAt ? new Date(readyAt).toISOString() : null;
}
