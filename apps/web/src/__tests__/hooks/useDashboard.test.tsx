import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dashboardService } from '@/services/dashboard.service';

vi.mock('@/services/dashboard.service', () => ({
  dashboardService: {
    seekers: vi.fn(),
    providers: vi.fn(),
    oppProviders: vi.fn(),
    dashboard: vi.fn(),
    dashboardItems: vi.fn(),
  },
}));

const { useSeekers, useProviders, useOppProviders, useDashboard, useDashboardItems } =
  await import('@/hooks/useDashboard');

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useSeekers / useProviders / useOppProviders', () => {
  afterEach(() => {
    vi.mocked(dashboardService.seekers).mockReset();
    vi.mocked(dashboardService.providers).mockReset();
    vi.mocked(dashboardService.oppProviders).mockReset();
  });

  it('useSeekers resolves with the mapped rows', async () => {
    vi.mocked(dashboardService.seekers).mockResolvedValue([{ id: 's-1' } as never]);
    const { result } = renderHook(() => useSeekers(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 's-1' }]);
  });

  it('useProviders passes the filter through', async () => {
    vi.mocked(dashboardService.providers).mockResolvedValue([]);
    const { result } = renderHook(() => useProviders({ status: 'active' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dashboardService.providers).toHaveBeenCalledWith({ status: 'active' });
  });

  it('useOppProviders resolves', async () => {
    vi.mocked(dashboardService.oppProviders).mockResolvedValue([]);
    const { result } = renderHook(() => useOppProviders(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useDashboardItems', () => {
  afterEach(() => {
    vi.mocked(dashboardService.dashboardItems).mockReset();
  });

  it('stays disabled (no fetch) until a domain is supplied', () => {
    const { result } = renderHook(() => useDashboardItems(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(dashboardService.dashboardItems).not.toHaveBeenCalled();
  });

  it('fetches items with defaults once a domain is set', async () => {
    vi.mocked(dashboardService.dashboardItems).mockResolvedValue({
      meta: {
        total: 0,
        limit: 200,
        offset: 0,
        tiles: { draft: 0, live: 0, paused: 0, account_only: 0 },
      },
      items: [],
    });
    const { result } = renderHook(() => useDashboardItems({ domain: 'seeker' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dashboardService.dashboardItems).toHaveBeenCalledWith({
      domain: 'seeker',
      limit: 200,
      offset: 0,
    });
  });

  it('includes the lifecycle filter when supplied', async () => {
    vi.mocked(dashboardService.dashboardItems).mockResolvedValue({
      meta: {
        total: 0,
        limit: 10,
        offset: 0,
        tiles: { draft: 0, live: 0, paused: 0, account_only: 0 },
      },
      items: [],
    });
    const { result } = renderHook(
      () => useDashboardItems({ domain: 'seeker', lifecycle: 'live', limit: 10, offset: 5 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dashboardService.dashboardItems).toHaveBeenCalledWith({
      domain: 'seeker',
      limit: 10,
      offset: 5,
      lifecycle: 'live',
    });
  });
});

describe('useDashboard', () => {
  afterEach(() => {
    vi.mocked(dashboardService.dashboard).mockReset();
  });

  it('stays disabled until a domain is provided', () => {
    const { result } = renderHook(() => useDashboard(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches the dashboard payload once domain is set', async () => {
    vi.mocked(dashboardService.dashboard).mockResolvedValue({
      by_domain: {},
      metadata: { last_computed_at: '2026-01-01', ttl_seconds: 60, refreshed: false },
    });
    const { result } = renderHook(() => useDashboard({ domain: 'seeker' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(dashboardService.dashboard).toHaveBeenCalledWith({ domain: 'seeker' });
  });
});
