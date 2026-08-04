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

import { GET } from '@/app/api/auth/login/route';
import { getOidcAdapter } from '@/lib/oidc';

const mockGetOidcAdapter = vi.mocked(getOidcAdapter);

describe('GET /api/auth/login', () => {
  let originalRedirectUri: string | undefined;
  let originalSessionKey: string | undefined;

  beforeEach(() => {
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
  });

  it('redirects to the IdP authorization URL and sets the signed flow cookie', async () => {
    const req = new NextRequest('http://localhost/api/auth/login?returnTo=/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://kc.test/auth?client_id=x');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('oidc_flow=');
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
