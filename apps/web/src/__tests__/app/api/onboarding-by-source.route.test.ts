/**
 * BFF route test: GET /api/onboarding/by-source.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/onboarding/by-source/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/onboarding/by-source', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the from/to date-range query params', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { sources: [] }));
    const res = await GET(
      new NextRequest(
        'http://localhost/api/onboarding/by-source?from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00%2B05%3A30',
      ),
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/onboarding/by-source?from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00%2B05%3A30',
      { method: 'GET' },
    );
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/onboarding/by-source'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/onboarding/by-source'));
    expect(res.status).toBe(503);
  });

  it('passes a non-JSON upstream body through as text', async () => {
    mockCallApi.mockResolvedValue(new Response('oops', { status: 500 }));
    const res = await GET(new NextRequest('http://localhost/api/onboarding/by-source'));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('oops');
  });
});

describe('GET /api/onboarding/by-source query check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['', ''],
    [
      '?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z',
      '?from=2026-01-01T00%3A00%3A00Z&to=2026-02-01T00%3A00%3A00Z',
    ],
  ])('forwards %j as %j', async (query, forwarded) => {
    mockCallApi.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await GET(new NextRequest(`http://localhost/api/onboarding/by-source${query}`));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      `/v1/onboarding/by-source${forwarded}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each(['?from=2026-01-01', '?to=2026-13-01T00:00:00Z'])(
    'rejects %j with 400 without calling upstream',
    async (query) => {
      const res = await GET(new NextRequest(`http://localhost/api/onboarding/by-source${query}`));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: 'SCHEMA_VALIDATION', title: 'Invalid query parameters' },
      });
      expect(mockCallApi).not.toHaveBeenCalled();
    },
  );
});
