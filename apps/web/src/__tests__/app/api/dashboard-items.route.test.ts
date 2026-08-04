/**
 * BFF route test: GET /api/dashboard/items.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/dashboard/items/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/dashboard/items', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the domain/limit/offset query params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { items: [] }));
    const res = await GET(
      new NextRequest('http://localhost/api/dashboard/items?domain=provider&limit=10&offset=0'),
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/dashboard/items?domain=provider&limit=10&offset=0',
      { method: 'GET' },
    );
  });

  it('omits the query string when there are no params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { items: [] }));
    await GET(new NextRequest('http://localhost/api/dashboard/items'));
    expect(mockCallApi).toHaveBeenCalledWith('/v1/dashboard/items', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard/items'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/dashboard/items'));
    expect(res.status).toBe(503);
  });
});
