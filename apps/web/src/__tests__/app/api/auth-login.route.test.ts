/**
 * BFF route test: GET /api/auth/login.
 *
 * Starts the OIDC Authorization Code + PKCE flow. Mocks `@/lib/oidc`
 * (adapter + generators) since the real adapter performs Keycloak
 * discovery over HTTP. Asserts the redirect target, the signed flow
 * cookie, and the open-redirect guard on `returnTo`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/oidc', () => ({
  getOidcAdapter: vi.fn(),
  oidcGenerators: {
    state: vi.fn(() => 'state-123'),
    nonce: vi.fn(() => 'nonce-123'),
    codeVerifier: vi.fn(() => 'verifier-123'),
    codeChallenge: vi.fn(() => 'challenge-123'),
  },
}));
vi.mock('@/lib/session', () => ({
  getSessionStore: vi.fn(),
}));

import { GET } from '@/app/api/auth/login/route';
import { getOidcAdapter } from '@/lib/oidc';
import { getSessionStore } from '@/lib/session';

const mockGetOidcAdapter = vi.mocked(getOidcAdapter);
const mockGetSessionStore = vi.mocked(getSessionStore);

describe('GET /api/auth/login', () => {
  let originalRedirectUri: string | undefined;
  let originalSessionKey: string | undefined;
  const store = {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(async () => undefined),
    close: vi.fn(),
    rememberSignIn: vi.fn(async () => undefined),
    takeSignIn: vi.fn(async (): Promise<string | null> => null),
  };

  beforeEach(() => {
    mockGetSessionStore.mockReturnValue(store as never);
    originalRedirectUri = process.env.OIDC_REDIRECT_URI;
    originalSessionKey = process.env.SESSION_KEY;
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.SESSION_KEY = 'x'.repeat(32);
    mockGetOidcAdapter.mockReturnValue({
      buildAuthorizationUrl: vi.fn(async () => 'https://kc.test/auth?client_id=x'),
      exchangeCode: vi.fn(),
      refresh: vi.fn(),
      buildLogoutUrl: vi.fn(),
    } as never);
  });

  afterEach(() => {
    if (originalRedirectUri === undefined) delete process.env.OIDC_REDIRECT_URI;
    else process.env.OIDC_REDIRECT_URI = originalRedirectUri;
    if (originalSessionKey === undefined) delete process.env.SESSION_KEY;
    else process.env.SESSION_KEY = originalSessionKey;
    vi.clearAllMocks();
    store.takeSignIn.mockResolvedValue(null);
  });

  it('redirects to the IdP authorization URL and sets the signed flow cookie', async () => {
    const req = new NextRequest('http://localhost/api/auth/login?returnTo=/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://kc.test/auth?client_id=x');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('oidc_flow=');
  });

  it('records the sign-in with the browser that started it, as long as the handshake cookie lasts', async () => {
    const res = await GET(new NextRequest('http://localhost/api/auth/login'));
    const browser = res.cookies.get('bd_signin_browser');
    expect(browser).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(store.rememberSignIn).toHaveBeenCalledWith('state-123', browser?.value, 300);
  });

  it('keeps the browser cookie across sign-ins in the same browser', async () => {
    await GET(
      new NextRequest('http://localhost/api/auth/login', {
        headers: { cookie: 'bd_signin_browser=this-browser' },
      }),
    );
    expect(store.rememberSignIn).toHaveBeenCalledWith('state-123', 'this-browser', 300);
  });

  it.each([
    ['an email address', 'Asha@Trrain.org', 'asha@trrain.org'],
    ['something that is not an email', 'not-an-email', undefined],
    ['an over-long value', `${'a'.repeat(320)}@x.org`, undefined],
  ])('forwards login_hint only for %s', async (_label, hint, expected) => {
    const build = vi.fn(async () => 'https://kc.test/auth');
    mockGetOidcAdapter.mockReturnValue({
      buildAuthorizationUrl: build,
      exchangeCode: vi.fn(),
      refresh: vi.fn(),
      buildLogoutUrl: vi.fn(),
    } as never);
    const req = new NextRequest(
      `http://localhost/api/auth/login?login_hint=${encodeURIComponent(hint)}`,
    );
    await GET(req);
    const input: unknown = build.mock.calls[0]?.at(0);
    expect(input).toBeDefined();
    expect((input as { loginHint?: string }).loginHint).toBe(expected);
  });
  it('defaults returnTo to / when absent', async () => {
    const req = new NextRequest('http://localhost/api/auth/login');
    const res = await GET(req);
    expect(res.status).toBe(302);
  });

  it('falls back to / for an open-redirect attempt (protocol-relative)', async () => {
    const req = new NextRequest('http://localhost/api/auth/login?returnTo=//evil.com');
    const res = await GET(req);
    expect(res.status).toBe(302);
    // We can't directly read the encrypted cookie's returnTo value, but the
    // route must not throw and must still redirect to the IdP.
    expect(res.headers.get('location')).toBe('https://kc.test/auth?client_id=x');
  });

  it('falls back to / for an open-redirect attempt (absolute URL)', async () => {
    const req = new NextRequest(
      'http://localhost/api/auth/login?returnTo=' + encodeURIComponent('https://evil.com/x'),
    );
    const res = await GET(req);
    expect(res.status).toBe(302);
  });

  describe('?switch=1 — sign in with a different account (#753)', () => {
    /**
     * The escape link must END the realm session. `prompt=login` only
     * re-authenticates the CURRENT user, so naming a different one made
     * Keycloak throw USER_CONFLICT, reported as `invalid_user_credentials` and
     * shown to the user as "Invalid username or password" — on a flow that
     * never asks for a password.
     */
    it('redirects to the end-session endpoint, not the authorization endpoint', async () => {
      const buildLogoutUrl = vi.fn(async () => 'https://kc.test/logout?client_id=x');
      const buildAuthorizationUrl = vi.fn(async () => 'https://kc.test/auth?client_id=x');
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl,
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl,
      } as never);

      const res = await GET(new NextRequest('http://localhost/api/auth/login?switch=1'));

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://kc.test/logout?client_id=x');
      // Regression guard: the old behaviour built an auth URL with prompt=login.
      expect(buildAuthorizationUrl).not.toHaveBeenCalled();
    });

    it('omits idToken so the adapter falls back to client_id', async () => {
      const buildLogoutUrl = vi.fn(async () => 'https://kc.test/logout');
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl,
      } as never);

      await GET(new NextRequest('http://localhost/api/auth/login?switch=1'));

      // The gate rejects before a session exists, so there is no token to hint
      // with; passing a stale or fabricated one would be worse than confirming.
      const arg = buildLogoutUrl.mock.calls[0]?.[0] as { idToken?: string };
      expect(arg.idToken).toBeUndefined();
      expect(arg).toHaveProperty('postLogoutRedirectUri');
    });

    it('carries the banner reason in a cookie and starts no OIDC flow', async () => {
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl: vi.fn(async () => 'https://kc.test/logout'),
      } as never);

      const res = await GET(new NextRequest('http://localhost/api/auth/login?switch=1'));

      const setCookie = res.headers.get('set-cookie') ?? '';
      // Keycloak strips query strings from post_logout_redirect_uri.
      expect(setCookie).toContain('bd_logout_reason=account_switch');
      // No code is exchanged on this leg, so a flow cookie would only go stale.
      expect(setCookie).not.toContain('oidc_flow=');
    });

    it('ends a live portal session and hints Keycloak when this browser started the sign-in', async () => {
      store.takeSignIn.mockResolvedValue('this-browser');
      store.get.mockResolvedValue({ ok: true, value: { idToken: 'id-token-a' } });
      const buildLogoutUrl = vi.fn(async () => 'https://kc.test/logout?id_token_hint=a');
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl,
      } as never);

      const res = await GET(
        new NextRequest('http://localhost/api/auth/login?switch=1&flow=state-b', {
          headers: { cookie: 'sid=sess-a; bd_signin_browser=this-browser' },
        }),
      );

      expect(store.takeSignIn).toHaveBeenCalledWith('state-b');
      // Without this, /login would send the visitor back to the old account's
      // dashboard after Keycloak signs out.
      expect(store.destroy).toHaveBeenCalledWith('sess-a');
      const arg = buildLogoutUrl.mock.calls[0]?.[0] as { idToken?: string };
      expect(arg.idToken).toBe('id-token-a');
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('sid=;');
      expect(setCookie).toContain('bd_logout_reason=account_switch');
    });

    it('falls back to client_id when the session cookie has no live session', async () => {
      store.takeSignIn.mockResolvedValue('this-browser');
      store.get.mockResolvedValue({ ok: false, error: new Error('not found') });
      const buildLogoutUrl = vi.fn(async () => 'https://kc.test/logout');
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl,
      } as never);

      await GET(
        new NextRequest('http://localhost/api/auth/login?switch=1&flow=state-b', {
          headers: { cookie: 'sid=gone; bd_signin_browser=this-browser' },
        }),
      );

      expect(store.destroy).toHaveBeenCalledWith('gone');
      const arg = buildLogoutUrl.mock.calls[0]?.[0] as { idToken?: string };
      expect(arg.idToken).toBeUndefined();
    });

    it('leaves the portal session alone when the flow is unknown', async () => {
      // A link from another site cannot name a live sign-in, so it must not be
      // able to sign the user out; Keycloak's confirmation page still guards.
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl: vi.fn(async () => 'https://kc.test/logout'),
      } as never);

      const res = await GET(
        new NextRequest('http://localhost/api/auth/login?switch=1&flow=forged', {
          headers: { cookie: 'sid=sess-a' },
        }),
      );

      expect(store.get).not.toHaveBeenCalled();
      expect(store.destroy).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie') ?? '').not.toContain('sid=;');
    });

    it('leaves the portal session alone when the sign-in was started in another browser', async () => {
      // An attacker can start their own sign-in and send its `state` in a link;
      // the record is live, but it carries the attacker's browser value.
      store.takeSignIn.mockResolvedValue('attacker-browser');
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl: vi.fn(async () => 'https://kc.test/logout'),
      } as never);

      const res = await GET(
        new NextRequest('http://localhost/api/auth/login?switch=1&flow=attacker-state', {
          headers: { cookie: 'sid=sess-a; bd_signin_browser=victim-browser' },
        }),
      );

      expect(store.get).not.toHaveBeenCalled();
      expect(store.destroy).not.toHaveBeenCalled();
      expect(res.headers.get('set-cookie') ?? '').not.toContain('sid=;');
    });

    it('leaves the portal session alone when no flow is given', async () => {
      mockGetOidcAdapter.mockReturnValue({
        buildAuthorizationUrl: vi.fn(),
        exchangeCode: vi.fn(),
        refresh: vi.fn(),
        buildLogoutUrl: vi.fn(async () => 'https://kc.test/logout'),
      } as never);

      await GET(
        new NextRequest('http://localhost/api/auth/login?switch=1', {
          headers: { cookie: 'sid=sess-a' },
        }),
      );

      expect(store.takeSignIn).not.toHaveBeenCalled();
      expect(store.destroy).not.toHaveBeenCalled();
    });
  });

  it('throws when OIDC_REDIRECT_URI is not configured', async () => {
    delete process.env.OIDC_REDIRECT_URI;
    const req = new NextRequest('http://localhost/api/auth/login');
    let caught: unknown;
    try {
      await GET(req);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('OIDC_REDIRECT_URI must be set');
  });
});
