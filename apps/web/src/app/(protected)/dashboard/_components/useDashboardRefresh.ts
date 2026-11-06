'use client';

/**
 * Forced refresh of the dashboard rollup (`web` app).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { dashboardService } from '@/services/dashboard.service';
import { failureText } from '../_lib/format';
import { PAGE_SIZE, statusQuery } from '../_lib/query';
import type { StatusFilter } from '../_lib/status';

/**
 * Asks Signals to recompute the rollup, then invalidates the domain's dashboard queries.
 *
 * @param domain - The tab's domain id; without one the refresh does nothing.
 * @param page - The current table page.
 * @param statusFilter - The active status filter.
 * @returns The refresh state and the handler for the refresh button.
 */
export function useDashboardRefresh(
  domain: string | undefined,
  page: number,
  statusFilter: StatusFilter,
) {
  const t = useTranslations('dashboard');
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (!domain) return;
      await dashboardService.dashboard({
        domain,
        page,
        limit: PAGE_SIZE,
        ...statusQuery(statusFilter),
        refresh: true,
      });
      await queryClient.invalidateQueries({ queryKey: ['dashboard', 'dashboard', domain] });
      setLastRefreshedAt(Date.now());
    } catch (err) {
      console.error('Dashboard refresh failed', err);
      setRefreshError(failureText(err, t('state.refreshUnreadable'), t('state.refreshFailed')));
    } finally {
      setRefreshing(false);
    }
  }

  return {
    refreshing,
    lastRefreshedAt,
    refreshError,
    onRefresh: () => {
      void refresh();
    },
  };
}
