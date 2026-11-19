/**
 * BFF route test: POST / DELETE /api/auth/acting and GET /api/auth/acting/leave.
 *
 * Uses the OIDC and session-store fakes. `/me` is answered by a stubbed
 * `fetch`; the assertions are about what the session holds afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { IdentityProviderFake, buildTokenSet } from '@/lib/oidc/testing';
import { SessionStoreFake, buildSessionData } from '@/lib/session/testing';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

const idp = new IdentityProviderFake();
const store = new SessionStoreFake({ ttlSec: 60 });
let cookieSid: string | undefined;
vi.mock('@/lib/oidc', () => ({ getOidcAdapter: () => idp }));
vi.mock('@/lib/session', () => ({ getSessionStore: () => store }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieSid ? { value: cookieSid } : undefined) }),
}));

import { POST, DELETE } from '@/app/api/auth/acting/route';
import { GET as LEAVE } from '@/app/api/auth/acting/leave/route';

const SID = 'sess-acting';
const ACCOUNT_ID = '7d0f2c1e-4b8a-4c3d-9e2f-1a2b3c4d5e6f';
const OTHER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PORTAL = 'http://portal.test';

/** An unsigned JWT carrying the given claims; the BFF only decodes it. */
function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

function me(own: string | null): MeResponse {
  return {
    kind: 'admin',
    user: { id: 'u-1', contact: { name: 'Owner', email: 'o@example.com', phone: null } },
    orgs: [],
    is_network_admin: false,
    own_coordinator_account_id: own,
  };
}

let meCalls: Headers[] = [];
function stubMe(body: MeResponse, status = 200): void {
  meCalls = [];
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    meCalls.push(new Headers(init?.headers));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function seed(overrides: Parameters<typeof buildSessionData>[0] = {}): void {
  store.seed([
    {
      sid: SID,
      data: buildSessionData({
        refreshToken: 'rt-1',
        consoleActor: { me: me(ACCOUNT_ID), at: Date.now() },
        ...overrides,
      }),
    },
  ]);
}

function seedRefresh(roles: string[]): void {
  idp.seedRefresh('rt-1', {
    ok: true,
    value: buildTokenSet({ accessToken: jwt({ roles }), refreshToken: 'rt-2' }),
  });
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${PORTAL}/api/auth/acting`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: PORTAL,
      cookie: `sid=${SID}`,
      ...headers,
    },
  });
}

async function stored() {
  const r = await store.get(SID);
  if (!r.ok) throw new Error('session missing');
  return r.value;
}

const origFetch = globalThis.fetch;

beforeEach(async () => {
  process.env.PUBLIC_PORTAL_URL = PORTAL;
  process.env.API_BASE_URL = 'http://api.internal:4000';
  cookieSid = SID;
  await store.destroy(SID);
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.PUBLIC_PORTAL_URL;
  delete process.env.API_BASE_URL;
});

describe('POST /api/auth/acting', () => {
  it('answers 401 without a session', async () => {
    cookieSid = undefined;
    const res = await POST(post({ accountId: ACCOUNT_ID }, { cookie: '' }));
    expect(res.status).toBe(401);
  });

  it('refuses a cross-site request', async () => {
    seed();
    const res = await POST(post({ accountId: ACCOUNT_ID }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect((await stored()).actingAccountId).toBeUndefined();
  });

  it('answers 400 for a body without a valid account id', async () => {
    seed();
    const res = await POST(post({ accountId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('answers 403 and leaves the session unchanged when the id is not the owner’s own account', async () => {
    seed();
    stubMe(me(OTHER_ID));
    const before = await stored();
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(403);
    const after = await stored();
    expect(after.actingAccountId).toBeUndefined();
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.consoleActor).toEqual(before.consoleActor);
  });

  it('answers 403 when the owner has no coordinator account', async () => {
    seed();
    stubMe(me(null));
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(403);
  });

  it('answers 403 when /me refuses the caller', async () => {
    seed();
    meCalls = [];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_ORG_ADMIN' } }), { status: 403 }),
    ) as unknown as typeof fetch;
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(403);
  });

  it('reads /me without the acting-account header even when already acting', async () => {
    seed({ actingAccountId: OTHER_ID });
    stubMe(me(ACCOUNT_ID));
    seedRefresh([`acting:${ACCOUNT_ID}:coordinator`]);
    await POST(post({ accountId: ACCOUNT_ID }));
    expect(meCalls).toHaveLength(1);
    expect(meCalls[0]?.has('x-acting-account')).toBe(false);
  });

  it('answers 409 ACTING_NOT_READY when the refreshed token has no entry for the account', async () => {
    seed();
    stubMe(me(ACCOUNT_ID));
    seedRefresh(['org_admin', `acting:${OTHER_ID}:coordinator`]);
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'ACTING_NOT_READY' } });
    expect((await stored()).actingAccountId).toBeUndefined();
  });

  it('answers 401 when the token refresh fails', async () => {
    seed({ refreshToken: 'rt-unknown' });
    stubMe(me(ACCOUNT_ID));
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(401);
  });

  it('stores the acting account, clears the actor cache and sends the owner to onboarding', async () => {
    seed();
    stubMe(me(ACCOUNT_ID));
    seedRefresh(['org_admin', `acting:${ACCOUNT_ID}:coordinator`]);
    const res = await POST(post({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: '/onboarding' });
    const after = await stored();
    expect(after.actingAccountId).toBe(ACCOUNT_ID);
    expect(after.consoleActor).toBeUndefined();
    expect(after.refreshToken).toBe('rt-2');
  });
});

describe('DELETE /api/auth/acting', () => {
  function del(returnTo?: string, cookie = `sid=${SID}`): NextRequest {
    const q = returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
    return new NextRequest(`${PORTAL}/api/auth/acting${q}`, {
      method: 'DELETE',
      headers: { cookie },
    });
  }

  it('clears the acting account and the actor cache and returns to the given path', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await DELETE(del('/console/team?tab=1'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PORTAL}/console/team?tab=1`);
    const after = await stored();
    expect(after.actingAccountId).toBeUndefined();
    expect(after.consoleActor).toBeUndefined();
  });

  it('returns to /console without a returnTo', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await DELETE(del());
    expect(res.headers.get('location')).toBe(`${PORTAL}/console`);
  });

  it.each([
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example/x',
    'javascript:alert(1)',
    'console',
  ])('ignores the off-origin returnTo %s', async (returnTo) => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await DELETE(del(returnTo));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console`);
    expect((await stored()).actingAccountId).toBeUndefined();
  });

  it('redirects to /console without a session', async () => {
    const res = await DELETE(del(undefined, ''));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console`);
  });
});

describe('GET /api/auth/acting/leave', () => {
  function leave(query: string, cookie = `sid=${SID}`): NextRequest {
    return new NextRequest(`${PORTAL}/api/auth/acting/leave${query}`, { headers: { cookie } });
  }

  it('clears the acting account and the actor cache, keeping an allowed reason', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await LEAVE(leave('?returnTo=%2Fconsole&reason=acting_ended'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${PORTAL}/console?reason=acting_ended`);
    const after = await stored();
    expect(after.actingAccountId).toBeUndefined();
    expect(after.consoleActor).toBeUndefined();
  });

  it('returns to the given console path', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await LEAVE(leave('?returnTo=%2Fconsole%2Fprofile'));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console/profile`);
  });

  it('drops a reason that is not on the list', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await LEAVE(leave('?returnTo=%2Fconsole&reason=%3Cscript%3E'));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console`);
  });

  it('ignores an off-origin returnTo', async () => {
    seed({ actingAccountId: ACCOUNT_ID });
    const res = await LEAVE(leave('?returnTo=%2F%2Fevil.example&reason=acting_ended'));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console?reason=acting_ended`);
  });

  it('redirects to /console without a session', async () => {
    const res = await LEAVE(leave('', ''));
    expect(res.headers.get('location')).toBe(`${PORTAL}/console`);
  });
});
