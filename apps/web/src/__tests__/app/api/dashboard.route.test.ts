/**
 * BFF route test: GET /api/dashboard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/dashboard/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/dashboard', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the rollup with domain/status query params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { tiles: [], rows: [] }));
    const res = await GET(
      new NextRequest('http://localhost/api/dashboard?domain=seeker&status=at_risk'),
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/dashboard?domain=seeker&status=at_risk', {
      method: 'GET',
    });
  });

  it('omits the query string when there are no params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { tiles: [], rows: [] }));
    await GET(new NextRequest('http://localhost/api/dashboard'));
    expect(mockCallApi).toHaveBeenCalledWith('/v1/dashboard', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard'));
    expect(res.status).toBe(503);
  });

  it('passes a non-JSON upstream body through as text', async () => {
    mockCallApi.mockResolvedValue(new Response('oops', { status: 502 }));
    const res = await GET(new NextRequest('http://localhost/api/dashboard'));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('oops');
  });
});

describe('GET /api/dashboard query check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['?domain=seeker', '?domain=seeker'],
    [
      '?domain=seeker&page=2&limit=200&status=At_Risk_2&lifecycle=draft&refresh=true',
      '?domain=seeker&page=2&limit=200&status=At_Risk_2&lifecycle=draft&refresh=true',
    ],
    ['?domain=seeker&refresh=false', '?domain=seeker&refresh=false'],
    ['?domain=seeker&lifecycle=live&other=1', '?domain=seeker&lifecycle=live'],
  ])('forwards %j as %j', async (query, forwarded) => {
    mockCallApi.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(new NextRequest(`http://localhost/api/dashboard${query}`));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      `/v1/dashboard${forwarded}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each([
    '?domain=',
    '?page=0',
    '?limit=201',
    '?status=at-risk',
    '?status=' + 'a'.repeat(33),
    '?status=%20',
    '?lifecycle=paused',
  ])('rejects %j with 400 without calling upstream', async (query) => {
    const res = await GET(new NextRequest(`http://localhost/api/dashboard${query}`));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
    });
    expect(mockCallApi).not.toHaveBeenCalled();
  });
});
