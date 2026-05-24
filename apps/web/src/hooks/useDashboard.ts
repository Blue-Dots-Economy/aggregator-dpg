'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardService, type DashboardQuery } from '../services/dashboard.service';
import type { ParticipantFilter } from '../types';

export function useSeekers(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['dashboard', 'seekers', filter],
    queryFn: () => dashboardService.seekers(filter),
  });
}

export function useProviders(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['dashboard', 'providers', filter],
    queryFn: () => dashboardService.providers(filter),
  });
}

export function useOppProviders(filter?: ParticipantFilter) {
  return useQuery({
    queryKey: ['dashboard', 'opp-providers', filter],
    queryFn: () => dashboardService.oppProviders(filter),
  });
}

/**
 * Reads the signalstack-backed aggregator dashboard payload.
 *
 * Default mount call carries no `status` so the rollup is full and the
 * participants list is unfiltered — the page renders by-status totals
 * from `rollup.by_status` and lets the user click a chip. When the user
 * selects a server-side status filter, pass `status` and the query-key
 * change triggers a refetch with `?status=…` applied upstream.
 */
export function useDashboard(query?: DashboardQuery) {
  const domain = query?.domain ?? 'seeker';
  const status = query?.status ?? null;
  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  return useQuery({
    queryKey: ['dashboard', 'dashboard', domain, status, page, limit],
    queryFn: () => dashboardService.dashboard(query),
  });
}
