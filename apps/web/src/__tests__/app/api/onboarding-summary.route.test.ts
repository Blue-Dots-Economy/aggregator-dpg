/**
 * BFF route test: GET /api/onboarding/summary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/onboarding/summary/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/onboarding/summary', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the from/to date-range query params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { total: 42 }));
    const res = await GET(
      new NextRequest(
        'http://localhost/api/onboarding/summary?from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00%2B05%3A30',
      ),
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/onboarding/summary?from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00%2B05%3A30',
      { method: 'GET' },
    );
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/onboarding/summary'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/onboarding/summary'));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/onboarding/summary query check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['', ''],
    ['?from=2026-01-01T00:00:00.000Z', '?from=2026-01-01T00%3A00%3A00.000Z'],
    ['?to=2026-01-01T10:00:00%2B05:30&x=1', '?to=2026-01-01T10%3A00%3A00%2B05%3A30'],
  ])('forwards %j as %j', async (query, forwarded) => {
    mockCallApi.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(new NextRequest(`http://localhost/api/onboarding/summary${query}`));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      `/v1/onboarding/summary${forwarded}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each(['?from=2026-01-01', '?to=yesterday'])(
    'rejects %j with 400 without calling upstream',
    async (query) => {
      const res = await GET(new NextRequest(`http://localhost/api/onboarding/summary${query}`));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
      });
      expect(mockCallApi).not.toHaveBeenCalled();
    },
  );
});
