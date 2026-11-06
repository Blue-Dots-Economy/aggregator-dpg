/**
 * Action-funnel parts for the Initiated and Received table cells (`web` app).
 */
import type { DirectionalStats } from '@/types';

/** One coloured segment of a funnel cell. */
export interface FunnelPart {
  v: number;
  color: string;
  label: string;
  short: string;
}

/**
 * Looks up a bucket label from config, then the fallback, then the raw key.
 *
 * @param labels - Bucket label map from config.
 * @param key - Bucket key (e.g. `'create'`, `'accept'`).
 * @param getFallback - Optional function that returns the localised fallback label for the key.
 * @returns The resolved label string.
 */
export function getBucketLabel(
  labels: Record<string, string>,
  key: string,
  getFallback?: (k: string) => string,
): string {
  return labels[key] ?? getFallback?.(key) ?? key;
}

/**
 * Builds the create/accept/reject/cancel funnel parts for one direction of a row's action counts.
 *
 * @param stats - The directional counts for the row.
 * @param labels - Config-sourced bucket labels for this direction.
 * @param fallback - Localised fallback label supplier.
 */
export function buildActionParts(
  stats: DirectionalStats,
  labels: Record<string, string>,
  fallback: (k: string) => string,
): FunnelPart[] {
  const part = (key: keyof DirectionalStats, color: string): FunnelPart => ({
    v: stats[key],
    color,
    label: getBucketLabel(labels, key, fallback),
    short: getBucketLabel(labels, key, fallback),
  });
  return [
    part('create', 'var(--bd-funnel-requested)'),
    part('accept', 'var(--bd-funnel-connected)'),
    part('reject', 'var(--bd-funnel-declined)'),
    part('cancel', 'var(--bd-funnel-cancelled)'),
  ];
}

/**
 * Sums the four action buckets of one direction.
 *
 * @param stats - The directional counts for the row.
 */
export function actionTotal(stats: DirectionalStats): number {
  return stats.create + stats.accept + stats.reject + stats.cancel;
}
