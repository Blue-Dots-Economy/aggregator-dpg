/**
 * BFF route test: GET /api/bulk-uploads/[id]/errors.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/[id]/errors/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/bulk-uploads/[id]/errors', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the errors.csv download from the encoded id path', async () => {
    mockCallApi.mockResolvedValue(
      new Response('row,error\n2,invalid_email', {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      }),
    );
    const res = await GET(
      new Request(
        'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/errors',
      ) as never,
      {
        params: Promise.resolve({ id: '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}' }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('invalid_email');
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/bulk-uploads/%7Ba0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11%7D/errors.csv',
      {
        method: 'GET',
      },
    );
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(
      new Request(
        'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/errors',
      ) as never,
      {
        params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(
      new Request(
        'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/errors',
      ) as never,
      {
        params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
      },
    );
    expect(res.status).toBe(503);
  });
});

describe('GET /api/bulk-uploads/[id]/errors id check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['l1', 'not-a-uuid', '../../v1/admin', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1'])(
    'returns the 404 NOT_FOUND envelope for %j without calling upstream',
    async (id) => {
      const res = await GET(new NextRequest('http://localhost/x', { method: 'GET' }), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: { code: 'NOT_FOUND', title: 'Not found' },
      });
      expect(mockCallApi).not.toHaveBeenCalled();
    },
  );

  it('accepts an upper-case UUID', async () => {
    mockCallApi.mockResolvedValue(new Response('row,error', { status: 200 }));
    const res = await GET(new NextRequest('http://localhost/x', { method: 'GET' }), {
      params: Promise.resolve({ id: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });
});
