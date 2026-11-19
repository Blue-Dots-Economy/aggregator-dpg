import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TERMS_STATUS_TIMEOUT_MS, fetchTermsStatus } from '@/lib/terms-status.server';
import { logger } from '@/lib/logger';

describe('fetchTermsStatus', () => {
  let originalFetch: typeof fetch;
  let seen: { url: string; auth: string | null }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.API_BASE_URL = 'http://api.test';
    seen = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function respond(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify(body), { status });
    });
  }

  const statusBody = (outstanding: boolean) => ({
    outstanding,
    audience: 'aggregator',
    terms_version: 3,
    privacy_version: 2,
    org_ids: [],
  });

  it('reports outstanding terms with the audience and versions', async () => {
    respond(200, statusBody(true));
    expect(await fetchTermsStatus('tok-1', logger)).toEqual({
      status: 'outstanding',
      audience: 'aggregator',
      termsVersion: 3,
      privacyVersion: 2,
    });
    expect(seen).toEqual([{ url: 'http://api.test/v1/user/consent/status', auth: 'Bearer tok-1' }]);
  });

  it('reports ok when nothing is outstanding', async () => {
    respond(200, statusBody(false));
    expect((await fetchTermsStatus('tok-1', logger)).status).toBe('ok');
  });

  it('reports unknown when the API fails', async () => {
    const warn = vi.spyOn(logger, 'warn');
    respond(500, { error: { code: 'DB_UNAVAILABLE' } });
    expect(await fetchTermsStatus('tok-1', logger)).toEqual({ status: 'unknown' });
    expect(warn).toHaveBeenCalled();
  });

  it('reports unknown when the body does not match the contract', async () => {
    respond(200, { outstanding: 'yes' });
    expect(await fetchTermsStatus('tok-1', logger)).toEqual({ status: 'unknown' });
  });

  it('reports unknown on a network failure', async () => {
    const warn = vi.spyOn(logger, 'warn');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down');
    });
    expect(await fetchTermsStatus('tok-1', logger)).toEqual({ status: 'unknown' });
    expect(warn).toHaveBeenCalled();
  });

  it('reports unknown when the API does not answer in time', async () => {
    vi.useFakeTimers();
    // Drive AbortSignal.timeout from the fake clock so the test can advance it.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    globalThis.fetch = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const pending = fetchTermsStatus('tok-1', logger);
    await vi.advanceTimersByTimeAsync(TERMS_STATUS_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 'unknown' });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5_000);
  });
});
