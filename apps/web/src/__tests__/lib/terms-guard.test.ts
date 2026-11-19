import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '@/lib/session';
import type * as TermsStatusModule from '@/lib/terms-status.server';

vi.mock('@/lib/server-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/upstream-client', () => ({ getFreshAccessToken: vi.fn(async () => 'AT-FRESH') }));
vi.mock('@/lib/terms-status.server', async (orig) => ({
  ...(await orig<typeof TermsStatusModule>()),
  fetchTermsStatus: vi.fn(),
}));
const update = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/session', () => ({ getSessionStore: () => ({ update }) }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: 'sid-1' }) })),
}));
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: logWarn, error: vi.fn(), info: vi.fn() } }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

import { ensureTermsAccepted, isTermsAllowedApiPath } from '@/lib/terms-guard.server';
import { getSession } from '@/lib/server-session';
import { fetchTermsStatus } from '@/lib/terms-status.server';
import { getFreshAccessToken } from '@/lib/upstream-client';

const base = { sub: 's', accessToken: 'AT' } as SessionData;
const withStatus = (termsStatus?: SessionData['termsStatus']) =>
  vi.mocked(getSession).mockResolvedValue({ ...base, ...(termsStatus ? { termsStatus } : {}) });

describe('ensureTermsAccepted', () => {
  beforeEach(() => vi.clearAllMocks());

  it('redirects an outstanding session to the terms page with the encoded path', async () => {
    withStatus('outstanding');
    await expect(ensureTermsAccepted('/dashboard?tab=a&b=1')).rejects.toThrow(
      `REDIRECT:/accept-terms?returnTo=${encodeURIComponent('/dashboard?tab=a&b=1')}`,
    );
    expect(fetchTermsStatus).not.toHaveBeenCalled();
  });

  it('returns for an ok session without checking again', async () => {
    withStatus('ok');
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
    expect(fetchTermsStatus).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('checks an absent status, stores ok and returns', async () => {
    withStatus(undefined);
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'ok' });
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
    expect(getFreshAccessToken).toHaveBeenCalled();
    expect(fetchTermsStatus).toHaveBeenCalledWith('AT-FRESH');
    expect(update).toHaveBeenCalledWith('sid-1', { termsStatus: 'ok' });
  });

  it('checks an absent status, stores outstanding and redirects', async () => {
    withStatus(undefined);
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'outstanding' });
    await expect(ensureTermsAccepted('/console')).rejects.toThrow(
      `REDIRECT:/accept-terms?returnTo=${encodeURIComponent('/console')}`,
    );
    expect(update).toHaveBeenCalledWith('sid-1', { termsStatus: 'outstanding' });
  });

  it('re-checks an unknown status', async () => {
    withStatus('unknown');
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'ok' });
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith('sid-1', { termsStatus: 'ok' });
  });

  it('lets the page load when the check fails (fail-open)', async () => {
    withStatus(undefined);
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'unknown' });
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
  });

  it('does not block the page when storing the status fails', async () => {
    withStatus(undefined);
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'ok' });
    update.mockRejectedValueOnce(new Error('redis down'));
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'terms.status.store', status: 'failure' }),
    );
  });

  it('logs a store that answers not-ok and still redirects on outstanding', async () => {
    withStatus(undefined);
    vi.mocked(fetchTermsStatus).mockResolvedValue({ status: 'outstanding' });
    update.mockResolvedValueOnce({ ok: false, error: { code: 'STORE_UNAVAILABLE' } } as never);
    await expect(ensureTermsAccepted('/dashboard')).rejects.toThrow('REDIRECT:/accept-terms');
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'terms.status.store', code: 'STORE_UNAVAILABLE' }),
    );
  });

  it('never redirects when already on the terms page', async () => {
    withStatus('outstanding');
    await expect(
      ensureTermsAccepted('/accept-terms?returnTo=%2Fdashboard'),
    ).resolves.toBeUndefined();
    await expect(ensureTermsAccepted('/accept-terms')).resolves.toBeUndefined();
  });

  it('returns when there is no session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(ensureTermsAccepted('/dashboard')).resolves.toBeUndefined();
    expect(fetchTermsStatus).not.toHaveBeenCalled();
  });
});

describe('isTermsAllowedApiPath', () => {
  it.each([
    '/v1/user/consent/status',
    '/v1/user/consent',
    '/v1/user/read/me',
    '/v1/support/config',
    '/v1/support',
    '/v1/user/read/me?x=1',
  ])('allows %s', (path) => expect(isTermsAllowedApiPath(path)).toBe(true));

  it.each([
    '/v1/dashboard/items',
    '/v1/user/consent/other',
    '/v1/user/consents',
    '/v1/support/tickets',
    '/v1/user/consent/',
  ])('blocks %s', (path) => expect(isTermsAllowedApiPath(path)).toBe(false));
});
