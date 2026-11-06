/**
 * Dashboard read queries for one domain tab (`web` app).
 */
import type { DashboardQuery } from '@/services/dashboard.service';
import { lifecycleQuery, type LifecycleFilterValue } from './lifecycle';
import type { StatusFilter } from './status';

/** Rows per dashboard table page. */
export const PAGE_SIZE = 25;

/** Filters of one domain tab. */
export interface DomainFilters {
  domain: string;
  statusFilter: StatusFilter;
  lifecycleFilter: LifecycleFilterValue;
}

/**
 * Returns the `status` part of a dashboard query.
 *
 * @param statusFilter - The active status filter; `'all'` sends no status.
 */
export function statusQuery(statusFilter: StatusFilter): { status?: string } {
  return statusFilter !== 'all' ? { status: statusFilter } : {};
}

/**
 * Builds the dashboard query for one table page.
 *
 * @param filters - Domain and active filters.
 * @param page - The 1-based page.
 */
export function pageQuery(filters: DomainFilters, page: number): DashboardQuery {
  return {
    domain: filters.domain,
    page,
    limit: PAGE_SIZE,
    ...statusQuery(filters.statusFilter),
    ...lifecycleQuery(filters.lifecycleFilter),
  };
}
