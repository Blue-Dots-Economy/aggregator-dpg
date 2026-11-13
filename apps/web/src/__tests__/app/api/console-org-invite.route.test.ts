import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));

import { POST } from '@/app/api/console/org/invite/route';
import { callApi } from '@/lib/upstream-client';

const body = {
  parent_id: '00000000-0000-4000-8000-0000000000c1',
  recipients: [{ email: 'a@x.org' }],
};

function post(headers: Record<string, string>) {
  const req = new NextRequest('http://portal.test/api/console/org/invite', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return POST(req);
}

describe('POST /api/console/org/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_PORTAL_URL;
  });

  it('forwards the invite with the caller token', async () => {
    vi.mocked(callApi).mockResolvedValue(
      new Response(JSON.stringify({ sent: 1, resent: 0, invalid: [], existing: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post({ 'content-type': 'application/json', origin: 'http://portal.test' });
    expect(res.status).toBe(200);
    expect(callApi).toHaveBeenCalledWith('/v1/org/invite', { method: 'POST', body });
  });

  it('refuses a cross-site request without calling the API', async () => {
    const res = await post({ 'content-type': 'application/json', origin: 'http://evil.test' });
    expect(res.status).toBe(403);
    expect(callApi).not.toHaveBeenCalled();
  });
});
