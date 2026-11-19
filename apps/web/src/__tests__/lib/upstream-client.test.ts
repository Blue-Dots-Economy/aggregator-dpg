import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('@/lib/server-session', () => ({ getSession: getSessionMock }));

const cookiesGetMock = vi.fn();
const requestPath = { value: '/onboarding' as string | null };
vi.mock('next/headers', () => ({
  cookies: () => ({ get: cookiesGetMock }),
  headers: async () => ({ get: (k: string) => (k === 'x-pathname' ? requestPath.value : null) }),
}));

const refreshMock = vi.fn();
vi.mock('@/lib/oidc', () => ({ getOidcAdapter: () => ({ refresh: refreshMock }) }));

const destroyMock = vi.fn();
const updateMock = vi.fn();
vi.mock('@/lib/session', () => ({
  getSessionStore: () => ({ destroy: destroyMock, update: updateMock }),
}));

const { getFreshAccessToken, refreshAccessToken, callApi } = await import('@/lib/upstream-client');

const FAR_FUTURE = Date.now() + 10 * 60_000;
const NEAR_EXPIRY = Date.now() + 30_000; // within the 60s refresh window
const ACCOUNT_ID = '7d0f2c1e-4b8a-4c3d-9e2f-1a2b3c4d5e6f';

describe('getFreshAccessToken', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    cookiesGetMock.mockReset();
    refreshMock.mockReset();
    destroyMock.mockReset();
    updateMock.mockReset();
  });

  it('returns null when there is no active session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(getFreshAccessToken()).resolves.toBeNull();
  });

  it('returns the current access token when it is not near expiry', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    await expect(getFreshAccessToken()).resolves.toBe('AT-1');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshes and persists the new tokens when near expiry', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue({ value: 'sid-1' });
    refreshMock.mockResolvedValue({
      ok: true,
      value: {
        accessToken: 'AT-NEW',
        refreshToken: 'RT-NEW',
        idToken: 'ID-NEW',
        accessTokenExp: FAR_FUTURE,
        refreshTokenExp: FAR_FUTURE,
      },
    });
    await expect(getFreshAccessToken()).resolves.toBe('AT-NEW');
    expect(updateMock).toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ accessToken: 'AT-NEW', refreshToken: 'RT-NEW' }),
    );
  });

  it('destroys the session and returns null when refresh fails', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue({ value: 'sid-2' });
    refreshMock.mockResolvedValue({ ok: false, error: { code: 'REFRESH_FAILED' } });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(destroyMock).toHaveBeenCalledWith('sid-2');
  });

  it('returns null on refresh failure when no sid cookie is present', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue(undefined);
    refreshMock.mockResolvedValue({ ok: false, error: { code: 'REFRESH_FAILED' } });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it('returns null after a successful refresh if the sid cookie vanished mid-flight', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: NEAR_EXPIRY,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue(undefined);
    refreshMock.mockResolvedValue({
      ok: true,
      value: {
        accessToken: 'AT-NEW',
        refreshToken: 'RT-NEW',
        idToken: 'ID-NEW',
        accessTokenExp: FAR_FUTURE,
        refreshTokenExp: FAR_FUTURE,
      },
    });
    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe('callApi', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    getSessionMock.mockReset();
    cookiesGetMock.mockReset();
    requestPath.value = '/onboarding';
    process.env.API_BASE_URL = 'http://api.internal:4000';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.API_BASE_URL;
  });

  it('attaches the Bearer token and calls the upstream API', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callApi('/v1/links');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.internal:4000/v1/links',
      expect.objectContaining({ method: 'GET' }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer AT-1');
  });

  it('sets a JSON content-type when a body is provided and none was set', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callApi('/v1/links', { method: 'POST', body: { a: 1 } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('throws when there is no active session', async () => {
    getSessionMock.mockResolvedValue(null);
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(callApi('/v1/links')).rejects.toThrow();
  });

  it('falls back to localhost:4000 when API_BASE_URL is unset', async () => {
    delete process.env.API_BASE_URL;
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/links');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/v1/links', expect.anything());
  });

  describe('while terms are outstanding', () => {
    it('refuses a gated path with 403 TERMS_REQUIRED and no upstream call', async () => {
      getSessionMock.mockResolvedValue({
        accessToken: 'AT-1',
        accessTokenExp: FAR_FUTURE,
        termsStatus: 'outstanding',
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const res = await callApi('/v1/dashboard/items?page=1');
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'TERMS_REQUIRED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes the consent call through', async () => {
      getSessionMock.mockResolvedValue({
        accessToken: 'AT-1',
        accessTokenExp: FAR_FUTURE,
        termsStatus: 'outstanding',
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const res = await callApi('/v1/user/consent', { method: 'POST', body: {} });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.internal:4000/v1/user/consent',
        expect.anything(),
      );
    });

    it('passes every call through for an ok session', async () => {
      getSessionMock.mockResolvedValue({
        accessToken: 'AT-1',
        accessTokenExp: FAR_FUTURE,
        termsStatus: 'ok',
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const res = await callApi('/v1/dashboard/items');
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('sends no acting-account header when the session has no acting account', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/links');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has('x-acting-account')).toBe(false);
  });

  it('sends the acting-account header when the session has an acting account', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-1',
      accessTokenExp: FAR_FUTURE,
      actingAccountId: ACCOUNT_ID,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/links');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get('x-acting-account')).toBe(ACCOUNT_ID);
  });

  it('leaves the acting-account header out when asked to call as the signed-in account', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-1',
      accessTokenExp: FAR_FUTURE,
      actingAccountId: ACCOUNT_ID,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/user/read/me', { asSignedInAccount: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has('x-acting-account')).toBe(false);
  });

  it.each(['/console', '/console/coordinators?org_id=1', '/api/console/org/invite'])(
    'leaves the acting-account header out for a request on the console path %s',
    async (path) => {
      requestPath.value = path;
      getSessionMock.mockResolvedValue({
        accessToken: 'AT-1',
        accessTokenExp: FAR_FUTURE,
        actingAccountId: ACCOUNT_ID,
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await callApi('/v1/user/read/me');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Headers).has('x-acting-account')).toBe(false);
    },
  );

  it.each(['/consoles', '/api/onboarding/summary', null])(
    'keeps the acting-account header for the non-console path %s',
    async (path) => {
      requestPath.value = path;
      getSessionMock.mockResolvedValue({
        accessToken: 'AT-1',
        accessTokenExp: FAR_FUTURE,
        actingAccountId: ACCOUNT_ID,
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      await callApi('/v1/links');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Headers).get('x-acting-account')).toBe(ACCOUNT_ID);
    },
  );

  it('drops a caller-supplied acting-account header', async () => {
    getSessionMock.mockResolvedValue({ accessToken: 'AT-1', accessTokenExp: FAR_FUTURE });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await callApi('/v1/links', { headers: { 'X-Acting-Account': ACCOUNT_ID } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).has('x-acting-account')).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    cookiesGetMock.mockReset();
    refreshMock.mockReset();
    destroyMock.mockReset();
    updateMock.mockReset();
  });

  it('refreshes even when the current token is far from expiry', async () => {
    getSessionMock.mockResolvedValue({
      accessToken: 'AT-OLD',
      accessTokenExp: FAR_FUTURE,
      refreshToken: 'RT-OLD',
    });
    cookiesGetMock.mockReturnValue({ value: 'sid-3' });
    refreshMock.mockResolvedValue({
      ok: true,
      value: {
        accessToken: 'AT-NEW',
        refreshToken: 'RT-NEW',
        idToken: 'ID-NEW',
        accessTokenExp: FAR_FUTURE,
        refreshTokenExp: FAR_FUTURE,
      },
    });
    await expect(refreshAccessToken()).resolves.toBe('AT-NEW');
    expect(refreshMock).toHaveBeenCalledWith('RT-OLD');
    expect(updateMock).toHaveBeenCalledWith(
      'sid-3',
      expect.objectContaining({ accessToken: 'AT-NEW' }),
    );
  });

  it('returns null when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
