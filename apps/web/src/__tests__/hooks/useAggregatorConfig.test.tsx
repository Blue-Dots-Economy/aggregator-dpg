import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { jsonFetch } from '@/services/http';

vi.mock('@/services/http', () => ({ jsonFetch: vi.fn() }));

const { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } =
  await import('@/hooks/useAggregatorConfig');

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAggregatorConfig', () => {
  afterEach(() => {
    vi.mocked(jsonFetch).mockReset();
  });

  it('exposes a conservative default payload shape for cold-mount rendering', () => {
    expect(DEFAULT_AGGREGATOR_CONFIG.network.id).toBe('blue_dot');
    expect(DEFAULT_AGGREGATOR_CONFIG.domains.length).toBeGreaterThan(0);
  });

  it('fetches the config from the BFF and resolves with the payload', async () => {
    const payload = {
      aggregator: { name: 'Agg' },
      brand: { short_name: 'BD', long_name: 'Blue Dots', url_slug: 'bd' },
      network: { id: 'blue_dot' },
      domains: [
        { id: 'seeker', label: 'Seekers', plural_label: 'Seekers', item_type: 'profile_1.0' },
      ],
    };
    vi.mocked(jsonFetch).mockResolvedValue(payload);

    const { result } = renderHook(() => useAggregatorConfig(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(jsonFetch).toHaveBeenCalledWith('/api/aggregator-config');
  });

  it('surfaces a fetch failure as an error state', async () => {
    vi.mocked(jsonFetch).mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useAggregatorConfig(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
