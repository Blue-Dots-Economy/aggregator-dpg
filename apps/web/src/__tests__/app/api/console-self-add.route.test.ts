/**
 * BFF route test: POST /api/console/user/self-add, an owner adding their own
 * coordinator account. Forwards to the API with the caller's token and drops
 * the cached console actor on success, so the console shows the new account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SessionStoreFake, buildSessionData } from '@/lib/session/testing';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

const store = new SessionStoreFake({ ttlSec: 60 });
vi.mock('@/lib/session', () => ({ getSessionStore: () => store }));
vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { POST } from '@/app/api/console/user/self-add/route';
import { callApi } from '@/lib/upstream-client';
import { SESSION_COOKIE } from '@/lib/cookies';

const SID = 'sess-self-add';
const PORTAL = 'http://portal.test';
const body = {
  org_id: '00000000-0000-4000-8000-0000000000a1',
  serves: ['seeker'],
  consent: { value: true, given_at: '2026-11-19T00:00:00Z', valid_till: '2027-11-19T00:00:00Z' },
};

const me: MeResponse = {
  kind: 'admin',
  user: { id: 'u-1', contact: { name: 'Owner', email: 'o@example.com', phone: null } },
  orgs: [],
  is_network_admin: false,
  own_coordinator_account_id: null,
};

function post(headers: Record<string, string> = {}) {
  return POST(
    new NextRequest(`${PORTAL}/api/console/user/self-add`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: PORTAL,
        cookie: `${SESSION_COOKIE}=${SID}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

const json = (b: unknown, status: number) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('POST /api/console/user/self-add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
    store.seed([{ sid: SID, data: buildSessionData({ consoleActor: { me, at: Date.now() } }) }]);
  });

  it('forwards the body to the API and drops the cached console actor', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 'c-1' }, 201));
    const res = await post();
    expect(res.status).toBe(201);
    expect(callApi).toHaveBeenCalledWith('/v1/user/self/add', { method: 'POST', body });
    const session = await store.get(SID);
    expect(session.ok && session.value.consoleActor).toBeUndefined();
  });

  it('passes a refusal through and keeps the cached actor', async () => {
    vi.mocked(callApi).mockResolvedValue(
      json({ error: { code: 'ALREADY_COORDINATOR', title: 'Conflict' } }, 409),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'ALREADY_COORDINATOR' } });
    const session = await store.get(SID);
    expect(session.ok && session.value.consoleActor?.me).toEqual(me);
  });

  it('refuses a cross-site request without calling the API', async () => {
    const res = await post({ origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });
});
