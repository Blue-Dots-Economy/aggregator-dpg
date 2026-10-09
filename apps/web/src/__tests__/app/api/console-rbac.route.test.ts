import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { POST as grant } from '@/app/api/console/user/grant/[id]/route';
import { POST as revoke } from '@/app/api/console/user/grant/revoke/[id]/route';
import { PATCH as setSet } from '@/app/api/console/org/permission-set/[id]/route';
import { callApi } from '@/lib/upstream-client';

const ID = '00000000-0000-4000-8000-0000000000c1';
const same = { 'content-type': 'application/json', origin: 'http://portal.test' };

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function call(
  handler: Handler,
  method: string,
  id: string,
  body: string,
  headers: Record<string, string> = same,
) {
  const req = new NextRequest(`http://portal.test/api/console/x/${id}`, { method, headers, body });
  return handler(req, { params: Promise.resolve({ id }) });
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const cases: Array<[string, Handler, string, string, string]> = [
  ['grant', grant, 'POST', `/v1/user/grant/${ID}`, '{"grant_key":"pii_access"}'],
  ['revoke', revoke, 'POST', `/v1/user/grant/revoke/${ID}`, '{"grant_key":"pii_access"}'],
  [
    'permission set',
    setSet,
    'PATCH',
    `/v1/org/permission-set/update/${ID}`,
    '{"permission_set":"aggregator"}',
  ],
];

describe('console RBAC BFF routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it.each(cases)('%s forwards with the caller token', async (_n, h, method, path, body) => {
    vi.mocked(callApi).mockResolvedValue(ok({ ok: true }));
    const res = await call(h, method, ID, body);
    expect(res.status).toBe(200);
    expect(callApi).toHaveBeenCalledWith(path, { method, body: JSON.parse(body) });
  });

  it.each(cases)('%s refuses a cross-site request', async (_n, h, method, _p, body) => {
    const res = await call(h, method, ID, body, {
      'content-type': 'application/json',
      origin: 'https://evil.test',
    });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });

  it.each(cases)('%s answers 404 for a malformed id', async (_n, h, method, _p, body) => {
    const res = await call(h, method, 'not-a-uuid', body);
    expect(res.status).toBe(404);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('passes a 409 refusal through unchanged', async () => {
    const envelope = { error: { code: 'PERMISSION_GRANT_EXCEEDS_ORG_SET' } };
    vi.mocked(callApi).mockResolvedValue(ok(envelope, 409));
    const res = await call(grant, 'POST', ID, '{"grant_key":"pii_access"}');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(envelope);
  });
});
