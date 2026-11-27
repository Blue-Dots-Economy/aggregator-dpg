import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/service-token', () => ({
  getServiceAccessToken: vi.fn(async () => 'svc-token'),
}));

import { readInvite } from '@/lib/invite-read.server';
import { getServiceAccessToken } from '@/lib/service-token';

describe('readInvite', () => {
  let originalFetch: typeof fetch;
  let calls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.API_BASE_URL = 'http://api.test';
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.mocked(getServiceAccessToken).mockResolvedValue('svc-token');
  });

  function respond(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(input.toString());
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  it('reads an org invite with the token in the query', async () => {
    const invite = {
      email: 'a@x.org',
      expires_at: '2099-01-01T00:00:00Z',
      org: { id: 'o', name: 'O' },
    };
    respond(200, invite);
    expect(await readInvite('org', 'a b')).toEqual({ ok: true, invite });
    expect(calls[0]).toBe('http://api.test/v1/org/invite/read?token=a%20b');
  });

  it.each([
    ['INVITE_INVALID', 400, 'invalid'],
    ['INVITE_EXPIRED', 410, 'expired'],
    ['INVITE_ALREADY_USED', 409, 'used'],
    ['TARGET_ORG_INACTIVE', 409, 'org_inactive'],
    ['SCHEMA_VALIDATION', 400, 'invalid'],
    ['DB_UNAVAILABLE', 503, 'unavailable'],
  ] as const)('maps %s to %s', async (code, status, reason) => {
    respond(status, { error: { code } });
    expect(await readInvite('user', 'tok')).toEqual({ ok: false, reason });
  });

  it('treats a malformed success body as unavailable', async () => {
    respond(200, { nope: true });
    expect(await readInvite('user', 'tok')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('treats an unreachable identity service as unavailable', async () => {
    vi.mocked(getServiceAccessToken).mockRejectedValue(new Error('down'));
    expect(await readInvite('user', 'tok')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
