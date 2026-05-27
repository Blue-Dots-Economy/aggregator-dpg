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
 * items list is unfiltered — the page renders by-status totals from
 * `rollup.by_status` and lets the user click a chip. When the user
 * selects a server-side status filter, pass `status` and the query-key
 * change triggers a refetch with `?status=…` applied upstream.
 *
 * Pass `refresh: true` to bypass the rollup TTL cache and force a
 * synchronous recompute on signalstack. `refresh` is included in the
 * query key so the forced refresh lands in a fresh React Query cache
 * entry rather than serving stale data from the prior key.
 */
export function useDashboard(query?: DashboardQuery) {
  const domain = query?.domain ?? 'seeker';
  const status = query?.status ?? null;
  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const refresh = query?.refresh ?? false;
  return useQuery({
    // refresh is in the queryKey so a forced refresh gets a fresh cache
    // entry rather than serving stale data from the prior key.
    queryKey: ['dashboard', 'dashboard', domain, status, page, limit, refresh],
    queryFn: () => dashboardService.dashboard(query),
    staleTime: 0,
  });
}
