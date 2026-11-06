/**
 * Status filter options and status-card copy for the dashboard (`web` app).
 */
import type { StatusRule } from '@/hooks/useAggregatorConfig';

/** `'all'` or any key Signals returns in `rollup.by_status`. */
export type StatusFilter = string;

/** One entry of the status filter menu. */
export interface StatusOption {
  value: StatusFilter;
  label: string;
  count?: number;
}

/** Label and description for one status card, from the domain's `status_rules`. */
export interface StatusCopy {
  label?: string;
  description?: string;
}

/**
 * Indexes a domain's `status_rules` by status key for the status cards.
 *
 * @param rules - The active domain's `status_rules` from network config.
 * @returns Map of status key to its optional label/description copy.
 */
export function indexStatusRules(rules: StatusRule[] | undefined): Record<string, StatusCopy> {
  const out: Record<string, StatusCopy> = {};
  for (const r of rules ?? []) {
    out[r.status] = {
      ...(r.label !== undefined ? { label: r.label } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    };
  }
  return out;
}

/**
 * Converts a snake_case or kebab-case status key to a Title Case label.
 *
 * @param key - Status key, e.g. `at_risk`.
 */
export function statusLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Builds the status filter menu from a rollup's `by_status` counts.
 *
 * @param byStatus - Count per status key.
 * @param allLabel - Label of the leading "no filter" option.
 * @returns The "all" option, then one option per non-empty key in reply order.
 */
export function buildStatusOptions(
  byStatus: Record<string, number> | undefined,
  allLabel: string,
): StatusOption[] {
  const opts: StatusOption[] = [{ value: 'all', label: allLabel }];
  if (!byStatus) return opts;
  for (const [key, count] of Object.entries(byStatus)) {
    if (!key) continue;
    opts.push({ value: key, label: statusLabel(key), count });
  }
  return opts;
}
