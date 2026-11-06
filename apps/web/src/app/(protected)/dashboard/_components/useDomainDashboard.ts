'use client';

/**
 * Data and filter state of one dashboard domain tab (`web` app).
 */
import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboard } from '@/hooks/useDashboard';
import { dashboardService } from '@/services/dashboard.service';
import type { ParticipantBase } from '@/types';
import { filterRowsByLifecycle, type LifecycleFilterValue } from '../_lib/lifecycle';
import { PAGE_SIZE, pageQuery } from '../_lib/query';
import { readAllMatching } from '../_lib/select-all';
import { buildStatusOptions, type StatusFilter } from '../_lib/status';
import type { SelectAllResult } from './ParticipantTable';
import { useLifecycleUrlFilter } from './useLifecycleUrlFilter';

/** Maps one Signals dashboard item to a table row. */
export type RowMapper<R extends ParticipantBase> = (
  participant: Record<string, unknown>,
  locale: string,
  index: number,
) => R;

/**
 * Reads one domain's dashboard page and holds its page, status and lifecycle filters.
 *
 * The status menu keeps the unfiltered status counts while a status filter is
 * set, so every status stays selectable.
 *
 * @param domainId - The coordinator's domain; `undefined` skips the read.
 * @param toRow - Maps an item to a table row.
 */
export function useDomainDashboard<R extends ParticipantBase>(
  domainId: string | undefined,
  toRow: RowMapper<R>,
) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Status counts from the last unfiltered reply, taken when a status filter is set.
  const [unfilteredByStatus, setUnfilteredByStatus] = useState<Record<string, number>>();
  const [lifecycleFilter, setLifecycleFilter] = useLifecycleUrlFilter();
  const filters = domainId ? { domain: domainId, statusFilter, lifecycleFilter } : undefined;

  const { data, isLoading, isError } = useDashboard(filters ? pageQuery(filters, page) : undefined);
  const slice = domainId ? data?.by_domain[domainId] : undefined;
  const rollup = slice?.rollup;
  const byStatus = rollup?.by_status ?? {};

  const onStatusFilterChange = (next: StatusFilter) => {
    if (statusFilter === 'all' && rollup) setUnfilteredByStatus(rollup.by_status);
    setPage(1);
    setStatusFilter(next);
  };
  const onLifecycleFilterChange = (next: LifecycleFilterValue) => {
    setPage(1);
    setLifecycleFilter(next);
  };

  const statusOptions = buildStatusOptions(
    statusFilter === 'all' ? byStatus : (unfilteredByStatus ?? byStatus),
    t('filters.all_statuses'),
  );

  const items = slice?.items;
  const rows = useMemo(
    () => (items ?? []).map((p, i) => toRow(p, locale, i)),
    [items, locale, toRow],
  );
  const filteredRows = useMemo(
    () => filterRowsByLifecycle(rows, lifecycleFilter),
    [rows, lifecycleFilter],
  );

  /**
   * Reads every row matching the current filters, for "Select all N matching".
   *
   * Reads in pages within the API's `limit` range.
   *
   * @param signal - Stops the read when the filters change.
   */
  const fetchAllMatching = async (signal: AbortSignal): Promise<SelectAllResult<R>> => {
    if (!filters) return { rows: [], complete: true };
    const read = await readAllMatching(
      async (pageNo, limit) => {
        const res = await dashboardService.dashboard({ ...pageQuery(filters, pageNo), limit });
        return res.by_domain[filters.domain]?.items ?? [];
      },
      slice?.total_matching ?? rollup?.total_items ?? PAGE_SIZE,
      signal,
    );
    const all = read.items.map((p, i) => toRow(p, locale, i));
    return { rows: filterRowsByLifecycle(all, lifecycleFilter), complete: read.complete };
  };

  return {
    page,
    setPage,
    statusFilter,
    onStatusFilterChange,
    statusOptions,
    lifecycleFilter,
    onLifecycleFilterChange,
    isLoading,
    isError,
    rollup,
    byStatus,
    total: rollup?.total_items,
    totalMatching: slice?.total_matching,
    rows: filteredRows,
    fetchAllMatching,
  };
}
