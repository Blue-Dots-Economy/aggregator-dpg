/**
 * Acting mode across the two layouts, with the real actor read, `callApi`,
 * leave route and an in-memory session store; only the API is stubbed (`fetch`).
 *
 * Checks that leaving acting mode ends on the console without a redirect loop:
 * the console layout leaves acting mode before it reads the actor, and the
 * coordinator layout ends it when `/me` refuses the acting account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SessionStoreFake, buildSessionData } from '@/lib/session/testing';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

const SID = 'sess-loop';
const ACCOUNT_ID = '7d0f2c1e-4b8a-4c3d-9e2f-1a2b3c4d5e6f';
const PORTAL = 'http://portal.test';

const store = new SessionStoreFake({ ttlSec: 60 });
const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('@/lib/session', () => ({ getSessionStore: () => store }));
vi.mock('@/lib/server-session', () => ({
  getSession: async () => {
    const r = await store.get(SID);
    return r.ok ? r.value : null;
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: SID }) }),
  headers: async () => ({ get: (k: string) => (k === 'x-pathname' ? nav.path : null) }),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('@/lib/support-enabled.server', () => ({ fetchSupportEnabled: async () => false }));
vi.mock('@/lib/signals-roles', () => ({ resolveSignalsRealmRoles: async () => [] }));
vi.mock('@/components/shell/Sidebar', () => ({ Sidebar: () => <nav /> }));
vi.mock('@/components/console/ConsoleSidebar', () => ({ ConsoleSidebar: () => <nav /> }));
vi.mock('@/components/console/ActingEndedNotice', () => ({ ActingEndedNotice: () => null }));

import ConsoleLayout from '@/app/(console)/console/layout';
import ProtectedLayout from '@/app/(protected)/layout';
import { GET as LEAVE } from '@/app/api/auth/acting/leave/route';
import { redirect } from 'next/navigation';

const ownerMe: MeResponse = {
  kind: 'admin',
  user: { id: 'admin-1', contact: { name: 'Owner', email: 'o@example.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  own_coordinator_account_id: ACCOUNT_ID,
};

/** API calls seen, with the acting-account header each carried. */
let calls: Array<{ path: string; acting: string | null }> = [];

/** Answers `/me`: 403 ACTING_ACCOUNT_INVALID with the acting header, the owner without. */
function stubApi(): void {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const acting = new Headers(init?.headers).get('x-acting-account');
    calls.push({ path, acting });
    if (path === '/v1/user/read/me' && acting) {
      return Response.json(
        { error: { code: 'ACTING_ACCOUNT_INVALID', title: 'Account not available' } },
        { status: 403 },
      );
    }
    if (path === '/v1/user/read/me') return Response.json(ownerMe);
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The URL `redirect()` was last called with. */
function lastRedirect(): string {
  const all = vi.mocked(redirect).mock.calls;
  return String(all[all.length - 1]?.[0]);
}

/** Follows a redirect to the leave route; returns where it sends the browser. */
async function followLeave(href: string): Promise<string> {
  const res = await LEAVE(
    new NextRequest(`${PORTAL}${href}`, { headers: { cookie: `sid=${SID}` } }),
  );
  expect(res.status).toBe(303);
  const target = new URL(res.headers.get('location') ?? '');
  return `${target.pathname}${target.search}`;
}

async function stored() {
  const r = await store.get(SID);
  if (!r.ok) throw new Error('session missing');
  return r.value;
}

const origFetch = globalThis.fetch;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.PUBLIC_PORTAL_URL = PORTAL;
  process.env.API_BASE_URL = 'http://api.internal:4000';
  await store.destroy(SID);
  store.seed([
    {
      sid: SID,
      data: buildSessionData({
        accessToken: 'h.e30.s',
        accessTokenExp: Date.now() + 1_000_000,
        refreshTokenExp: Date.now() + 1_000_000,
        actingAccountId: ACCOUNT_ID,
        termsStatus: 'ok',
      }),
    },
  ]);
  stubApi();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.PUBLIC_PORTAL_URL;
  delete process.env.API_BASE_URL;
});

describe('acting mode across the layouts', () => {
  it('the console layout leaves acting mode without reading the actor, then renders the console', async () => {
    nav.path = '/console/coordinators';
    await expect(ConsoleLayout({ children: null })).rejects.toThrow('REDIRECT:');
    expect(calls).toEqual([]);

    const next = await followLeave(lastRedirect());
    expect(next).toBe('/console/coordinators');
    expect((await stored()).actingAccountId).toBeUndefined();

    // The second render is not acting and does not redirect again.
    vi.mocked(redirect).mockClear();
    nav.path = next;
    expect(await ConsoleLayout({ children: null })).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(calls).toEqual([{ path: '/v1/user/read/me', acting: null }]);
  });

  it('the coordinator layout ends a refused acting account on the console notice, without a loop', async () => {
    nav.path = '/onboarding';
    await expect(ProtectedLayout({ children: null })).rejects.toThrow('REDIRECT:');
    expect(calls).toContainEqual({ path: '/v1/user/read/me', acting: ACCOUNT_ID });

    const next = await followLeave(lastRedirect());
    expect(next).toBe('/console?reason=acting_ended');
    const after = await stored();
    expect(after.actingAccountId).toBeUndefined();
    expect(after.consoleActor).toBeUndefined();

    vi.mocked(redirect).mockClear();
    calls = [];
    nav.path = next;
    expect(await ConsoleLayout({ children: null })).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    expect(calls).toEqual([{ path: '/v1/user/read/me', acting: null }]);
  });
});
