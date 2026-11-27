/**
 * BFF route tests: POST /api/invite/user/accept and POST /api/invite/org/accept.
 *
 * Each is a thin `proxyServiceRequest` wrapper; the tests pin the upstream
 * path and the service token, and that an upstream error passes through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/service-token', () => ({
  getServiceAccessToken: vi.fn(async () => 'svc-token'),
}));

import { POST as acceptUser } from '@/app/api/invite/user/accept/route';
import { POST as acceptOrg } from '@/app/api/invite/org/accept/route';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe.each([
  ['user', acceptUser, 'http://api.test/v1/user/invite/accept'],
  ['org', acceptOrg, 'http://api.test/v1/org/invite/accept'],
] as const)('POST /api/invite/%s/accept', (kind, POST, upstream) => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;
  const calls: { url: string; init: FetchInit }[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
    calls.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
  });

  function respond(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  const request = () =>
    new Request(`http://localhost/api/invite/${kind}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: 'tok' }),
    });

  it('forwards the body to the accept endpoint with a service token', async () => {
    respond(201, { status: 'pending', login_hint: 'a@x.org' });
    const res = await POST(request() as never);
    expect(res.status).toBe(201);
    expect(calls[0]?.url).toBe(upstream);
    const init = calls[0]?.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.['Authorization']).toBe('Bearer svc-token');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ invite: 'tok' });
  });

  it('passes an upstream refusal through', async () => {
    respond(400, { error: { code: 'INVITE_EMAIL_MISMATCH' } });
    const res = await POST(request() as never);
    expect(res.status).toBe(400);
  });
});
