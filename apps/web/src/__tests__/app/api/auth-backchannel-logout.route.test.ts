/**
 * BFF route test: POST /api/auth/backchannel-logout.
 *
 * Uses the OIDC and session-store fakes: a seeded logout token stands in for a
 * verified Keycloak token, and the assertions are about which portal sessions
 * survive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { IdentityProviderFake } from '@/lib/oidc/testing';
import { SessionStoreFake, buildSessionData } from '@/lib/session/testing';

const idp = new IdentityProviderFake();
const store = new SessionStoreFake({ ttlSec: 60 });
vi.mock('@/lib/oidc', () => ({ getOidcAdapter: () => idp }));
vi.mock('@/lib/session', () => ({ getSessionStore: () => store }));

import { POST } from '@/app/api/auth/backchannel-logout/route';

function backchannel(body: string, contentType = 'application/x-www-form-urlencoded') {
  return new NextRequest('http://localhost/api/auth/backchannel-logout', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('POST /api/auth/backchannel-logout', () => {
  beforeEach(() => {
    store._reset();
  });

  it('ends every portal session created under the Keycloak session the token names', async () => {
    idp.seedLogoutToken('valid-token', 'kc-1');
    const a = await store.create(buildSessionData({ idpSid: 'kc-1' }));
    const b = await store.create(buildSessionData({ idpSid: 'kc-1' }));
    const other = await store.create(buildSessionData({ idpSid: 'kc-2' }));

    const res = await POST(backchannel('logout_token=valid-token'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await store.get(a)).ok).toBe(false);
    expect((await store.get(b)).ok).toBe(false);
    // Another Keycloak session (another person in another browser) is untouched.
    expect((await store.get(other)).ok).toBe(true);
  });

  it('rejects a token the adapter does not accept, and ends nothing', async () => {
    const kept = await store.create(buildSessionData({ idpSid: 'kc-1' }));

    const res = await POST(backchannel('logout_token=forged'));

    expect(res.status).toBe(400);
    expect((await store.get(kept)).ok).toBe(true);
  });

  it('rejects a request without a logout token', async () => {
    expect((await POST(backchannel('other=1'))).status).toBe(400);
    expect((await POST(backchannel('{}', 'application/json'))).status).toBe(400);
  });

  it('reports unreachable keys as unavailable, so it is not mistaken for a bad token', async () => {
    const verify = vi
      .spyOn(idp, 'verifyLogoutToken')
      .mockResolvedValueOnce({ ok: false, error: { code: 'KEYS_UNAVAILABLE', message: 'down' } });

    const res = await POST(backchannel('logout_token=valid-token'));

    expect(res.status).toBe(503);
    verify.mockRestore();
  });
});
