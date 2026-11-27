/**
 * BFF route test: POST /api/bulk-uploads/[id]/start.
 *
 * Unlike sibling routes, this handler swallows a bad-JSON body into `{}`
 * (`req.json().catch(() => ({}))`) rather than returning 400 — covered
 * explicitly below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { POST } from '@/app/api/bulk-uploads/[id]/start/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/bulk-uploads/[id]/start', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the attestation body to the encoded id path', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { status: 'queued' }));
    const req = new Request(
      'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/start',
      {
        method: 'POST',
        body: JSON.stringify({ attestation: true }),
      },
    );
    const res = await POST(req as never, {
      params: Promise.resolve({ id: '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/bulk-uploads/%7Ba0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11%7D/start',
      {
        method: 'POST',
        body: { attestation: true },
      },
    );
  });

  it('defaults to an empty body when the request has no/invalid JSON', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, { status: 'queued' }));
    const req = new Request(
      'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/start',
      {
        method: 'POST',
        body: 'not json',
      },
    );
    const res = await POST(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/start',
      {
        method: 'POST',
        body: {},
      },
    );
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request(
      'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/start',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
    const res = await POST(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request(
      'http://localhost/api/bulk-uploads/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/start',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
    const res = await POST(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/bulk-uploads/[id]/start id check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['l1', 'not-a-uuid', '../../v1/admin', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1'])(
    'returns the 404 NOT_FOUND envelope for %j without calling upstream',
    async (id) => {
      const res = await POST(
        new NextRequest('http://localhost/x', {
          method: 'POST',
          body: JSON.stringify({ attestation: true }),
        }),
        {
          params: Promise.resolve({ id }),
        },
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: { code: 'NOT_FOUND', title: 'Not found' },
      });
      expect(mockCallApi).not.toHaveBeenCalled();
    },
  );

  it('accepts an upper-case UUID', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(200, {}));
    const res = await POST(
      new NextRequest('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ attestation: true }),
      }),
      {
        params: Promise.resolve({ id: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });
});
