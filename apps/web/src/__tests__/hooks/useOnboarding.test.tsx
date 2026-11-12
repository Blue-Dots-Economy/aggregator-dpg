import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { onboardingService } from '@/services/onboarding.service';

vi.mock('@/services/onboarding.service', () => ({
  onboardingService: {
    listLinks: vi.fn(),
    createLink: vi.fn(),
    updateLink: vi.fn(),
    activateLink: vi.fn(),
    deactivateLink: vi.fn(),
    summary: vi.fn(),
    bySource: vi.fn(),
    uploadCsv: vi.fn(),
    readBulkUpload: vi.fn(),
    listBulkUploads: vi.fn(),
  },
}));

const {
  useRegistrationLinks,
  useCreateLink,
  useUpdateLink,
  useActivateLink,
  useDeactivateLink,
  useOnboardingSummary,
  useOnboardingBySource,
  useBulkUpload,
  useRecentBulkUploads,
} = await import('@/hooks/useOnboarding');

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

const svc = onboardingService as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('useOnboarding hooks', () => {
  afterEach(() => {
    for (const fn of Object.values(svc)) fn.mockReset();
  });

  it('useRegistrationLinks unwraps the items array from the list response', async () => {
    svc.listLinks!.mockResolvedValue({ items: [{ link_id: '1' }], total: 1, limit: 50, offset: 0 });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRegistrationLinks('seeker'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ link_id: '1' }]);
    expect(svc.listLinks).toHaveBeenCalledWith({ domain: 'seeker' });
  });

  it('useCreateLink invalidates the links query for the created link domain', async () => {
    const link = { link_id: '1', domain: 'seeker' };
    svc.createLink!.mockResolvedValue(link);
    const { client, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateLink(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ domain: 'seeker' });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['onboarding', 'links', 'seeker'] });
  });

  it('useUpdateLink calls the service with id + patch and invalidates', async () => {
    const link = { link_id: '2', domain: 'provider' };
    svc.updateLink!.mockResolvedValue(link);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUpdateLink(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: '2', patch: { slug: 'new-slug' } });
    });
    expect(svc.updateLink).toHaveBeenCalledWith('2', { slug: 'new-slug' });
  });

  it('useActivateLink / useDeactivateLink call through', async () => {
    svc.activateLink!.mockResolvedValue({ link_id: '3', domain: 'seeker' });
    svc.deactivateLink!.mockResolvedValue({ link_id: '3', domain: 'seeker' });
    const { wrapper } = makeWrapper();
    const activate = renderHook(() => useActivateLink(), { wrapper });
    await act(async () => {
      await activate.result.current.mutateAsync('3');
    });
    expect(svc.activateLink).toHaveBeenCalledWith('3');

    const deactivate = renderHook(() => useDeactivateLink(), { wrapper });
    await act(async () => {
      await deactivate.result.current.mutateAsync('3');
    });
    expect(svc.deactivateLink).toHaveBeenCalledWith('3');
  });

  it('useOnboardingSummary / useOnboardingBySource resolve', async () => {
    svc.summary!.mockResolvedValue({
      aggregator_id: 'a1',
      from: null,
      to: null,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    });
    svc.bySource!.mockResolvedValue({ aggregator_id: 'a1', from: null, to: null, by_source: [] });
    const { wrapper } = makeWrapper();
    const s1 = renderHook(() => useOnboardingSummary(), { wrapper });
    await waitFor(() => expect(s1.result.current.isSuccess).toBe(true));
    const s2 = renderHook(() => useOnboardingBySource(), { wrapper });
    await waitFor(() => expect(s2.result.current.isSuccess).toBe(true));
  });

  it('useBulkUpload delegates to onboardingService.uploadCsv and invalidates summary', async () => {
    svc.uploadCsv!.mockResolvedValue({ uploadId: 'u1', status: { upload_id: 'u1' } });
    const { client, wrapper } = makeWrapper();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useBulkUpload(), { wrapper });
    const file = new File(['a,b'], 'x.csv', { type: 'text/csv' });
    await act(async () => {
      await result.current.mutateAsync({
        file,
        participantType: 'seeker',
        attestation: true,
        maxBytes: 1000,
      });
    });
    expect(svc.uploadCsv).toHaveBeenCalledWith(file, 'seeker', true, 1000);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['onboarding', 'summary'] });
  });

  it('useRecentBulkUploads reflects in-flight items via refetchInterval config', async () => {
    svc.listBulkUploads!.mockResolvedValue({
      items: [{ upload_id: 'u1', status: 'pending' }],
      total: 1,
      limit: 10,
      offset: 0,
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useRecentBulkUploads(5), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(svc.listBulkUploads).toHaveBeenCalledWith({ limit: 5 });
  });

  describe('useRecentBulkUploads polling', () => {
    const POLL_MS = 3000;

    async function pollCallsAfterInitialFetch(statuses: string[]) {
      svc.listBulkUploads!.mockResolvedValue({
        items: statuses.map((status, i) => ({ upload_id: `u${i}`, status })),
        total: statuses.length,
        limit: 10,
        offset: 0,
      });
      const { wrapper } = makeWrapper();
      renderHook(() => useRecentBulkUploads(), { wrapper });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(svc.listBulkUploads).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      });
      return svc.listBulkUploads!.mock.calls.length - 1;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each(['uploaded', 'file_validating', 'row_processing', 'finalising'])(
      'refetches on the interval while an upload is %s',
      async (status) => {
        expect(await pollCallsAfterInitialFetch([status])).toBe(3);
      },
    );

    it('does not refetch on the interval when the only unfinished uploads are pending', async () => {
      expect(await pollCallsAfterInitialFetch(['pending', 'completed', 'failed'])).toBe(0);
    });

    it('does not refetch on the interval when every upload is completed or failed', async () => {
      expect(await pollCallsAfterInitialFetch(['completed', 'failed'])).toBe(0);
    });
  });
});
