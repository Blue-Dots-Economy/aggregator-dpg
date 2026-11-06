import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type * as AggregatorConfigModule from '@/hooks/useAggregatorConfig';

const { useProfileRaw, useAggregatorConfig, replace, search } = vi.hoisted(() => ({
  useProfileRaw: vi.fn(),
  useAggregatorConfig: vi.fn(),
  replace: vi.fn(),
  search: { value: '' },
}));

vi.mock('@/hooks/useProfile', () => ({ useProfileRaw }));
vi.mock('@/hooks/useAggregatorConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof AggregatorConfigModule>();
  return { ...actual, useAggregatorConfig };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(search.value),
}));

import {
  ACTIVE_DOMAIN_STORAGE_KEY,
  resolveActiveDomain,
  servedNetworkDomains,
  useActiveDomain,
} from '@/hooks/useActiveDomain';

const SEEKER = { id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' };
const PROVIDER = {
  id: 'provider',
  label: 'Provider',
  plural_label: 'Providers',
  item_type: 'job_posting_1.0',
};

function mockProfile(serves: string[] | undefined, type: string | null = serves?.[0] ?? null) {
  useProfileRaw.mockReturnValue({
    data: { type, ...(serves ? { serves } : {}) },
    isSuccess: true,
    isError: false,
  });
}

describe('resolveActiveDomain', () => {
  const served = ['seeker', 'provider'];

  it('prefers a served URL value', () => {
    expect(resolveActiveDomain(served, 'provider', 'seeker')).toBe('provider');
  });

  it('falls back to the stored choice when the URL value is not served', () => {
    expect(resolveActiveDomain(served, 'learner', 'provider')).toBe('provider');
  });

  it('falls back to the first served domain', () => {
    expect(resolveActiveDomain(served, null, 'learner')).toBe('seeker');
  });

  it('returns undefined when nothing is served', () => {
    expect(resolveActiveDomain([], 'seeker', 'seeker')).toBeUndefined();
  });
});

describe('servedNetworkDomains', () => {
  it('returns every network domain for an empty list', () => {
    expect(servedNetworkDomains([], [SEEKER, PROVIDER])).toEqual([SEEKER, PROVIDER]);
  });

  it('keeps network order and drops domains not served', () => {
    expect(servedNetworkDomains(['provider'], [SEEKER, PROVIDER])).toEqual([PROVIDER]);
  });
});

describe('useActiveDomain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    replace.mockReset();
    search.value = '';
    useAggregatorConfig.mockReturnValue({
      data: { domains: [SEEKER, PROVIDER] },
      isLoading: false,
    });
  });

  it('opens on the first served domain', async () => {
    mockProfile(['seeker', 'provider']);
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.active).toBe('seeker');
    expect(result.current.domains.map((d) => d.id)).toEqual(['seeker', 'provider']);
  });

  it('uses the stored choice', async () => {
    window.localStorage.setItem(ACTIVE_DOMAIN_STORAGE_KEY, 'provider');
    mockProfile(['seeker', 'provider']);
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.active).toBe('provider'));
  });

  it('ignores a URL domain the coordinator does not serve', async () => {
    search.value = 'domain=provider';
    mockProfile(['seeker']);
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.active).toBe('seeker');
  });

  it('serves every network domain when the profile lists none', async () => {
    mockProfile([]);
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.domains).toHaveLength(2);
    expect(result.current.active).toBe('seeker');
  });

  it('falls back to type when the API sends no serves', async () => {
    mockProfile(undefined, 'provider');
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.active).toBe('provider'));
  });

  it('is not ready while the network config loads', () => {
    mockProfile(['seeker']);
    useAggregatorConfig.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useActiveDomain());
    expect(result.current.ready).toBe(false);
    expect(result.current.active).toBeUndefined();
  });

  it('is ready with no domain when the profile fails to load', async () => {
    useProfileRaw.mockReturnValue({ data: undefined, isSuccess: false, isError: true });
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.active).toBeUndefined();
  });

  it('setActive stores the choice and writes it to the URL', async () => {
    search.value = 'lifecycle=draft';
    mockProfile(['seeker', 'provider']);
    const { result } = renderHook(() => useActiveDomain());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setActive('provider'));
    expect(window.localStorage.getItem(ACTIVE_DOMAIN_STORAGE_KEY)).toBe('provider');
    expect(replace).toHaveBeenCalledWith('/dashboard?lifecycle=draft&domain=provider', {
      scroll: false,
    });
  });
});
