'use client';

import { useQuery } from '@tanstack/react-query';
import {
  dashboardService,
  type DashboardQuery,
  type DashboardItemsQuery,
} from '../services/dashboard.service';
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
/**
 * Reads the lifecycle-aware items endpoint (`/v1/dashboard/items`).
 *
 * Sources the lifecycle tile counts (`meta.tiles`) and the per-item
 * `lifecycle_status` the page needs to render the
 * lifecycle column. Pass `lifecycle` to narrow the items list to a
 * single bucket; tiles always reflect totals regardless.
 *
 * `enabled` gates the call on `domain` so cold mount stays quiet until
 * the network config resolves.
 */
export function useDashboardItems(query?: DashboardItemsQuery) {
  const domain = query?.domain;
  const lifecycle = query?.lifecycle ?? null;
  const limit = query?.limit ?? 200;
  const offset = query?.offset ?? 0;
  return useQuery({
    queryKey: ['dashboard', 'items', domain ?? '(no-domain)', lifecycle, limit, offset],
    queryFn: () =>
      dashboardService.dashboardItems({
        domain: domain as string,
        limit,
        offset,
        ...(lifecycle ? { lifecycle } : {}),
      }),
    enabled: Boolean(domain),
    staleTime: 0,
  });
}

export function useDashboard(query?: DashboardQuery) {
  // Domain must come from the network config (cfg.domains[N].id) so the
  // tab works for any network. Callers always pass it; we no longer
  // default to 'seeker' which silently broke orange_dot.
  const domain = query?.domain;
  const status = query?.status ?? null;
  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const refresh = query?.refresh ?? false;
  return useQuery({
    // refresh is in the queryKey so a forced refresh gets a fresh cache
    // entry rather than serving stale data from the prior key.
    queryKey: ['dashboard', 'dashboard', domain ?? '(no-domain)', status, page, limit, refresh],
    queryFn: () => dashboardService.dashboard(query),
    enabled: Boolean(domain),
    staleTime: 0,
  });
}
