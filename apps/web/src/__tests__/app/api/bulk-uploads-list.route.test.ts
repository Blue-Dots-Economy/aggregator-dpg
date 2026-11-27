/**
 * BFF route test: GET /api/bulk-uploads/list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/list/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/bulk-uploads/list', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the pagination query string verbatim', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    const res = await GET(
      new NextRequest('http://localhost/api/bulk-uploads/list?limit=20&offset=40') as never,
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads?limit=20&offset=40', {
      method: 'GET',
    });
  });

  it('omits the query string when there are no params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
    await GET(new NextRequest('http://localhost/api/bulk-uploads/list'));
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads', { method: 'GET' });
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/list'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/list'));
    expect(res.status).toBe(503);
  });

  it('passes a non-JSON upstream body through as text', async () => {
    mockCallApi.mockResolvedValue(new Response('oops', { status: 500 }));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/list'));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('oops');
  });
});

describe('GET /api/bulk-uploads/list query check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['', ''],
    ['?limit=1&offset=0', '?limit=1&offset=0'],
    ['?limit=100&x=y', '?limit=100'],
  ])('forwards %j as %j', async (query, forwarded) => {
    mockCallApi.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(new NextRequest(`http://localhost/api/bulk-uploads/list${query}`));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      `/v1/bulk-uploads${forwarded}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each(['?limit=0', '?limit=101', '?offset=-1', '?offset=x'])(
    'rejects %j with 400 without calling upstream',
    async (query) => {
      const res = await GET(new NextRequest(`http://localhost/api/bulk-uploads/list${query}`));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
      });
      expect(mockCallApi).not.toHaveBeenCalled();
    },
  );
});
