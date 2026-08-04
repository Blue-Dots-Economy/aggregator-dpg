import { describe, it, expect } from 'vitest';
import { queryClient } from '@/lib/query-client';

describe('queryClient', () => {
  it('is a QueryClient configured with the shared default options', () => {
    const opts = queryClient.getDefaultOptions();
    expect(opts.queries?.staleTime).toBe(30_000);
    expect(opts.queries?.refetchOnWindowFocus).toBe(false);
    expect(opts.queries?.retry).toBe(1);
  });
});
