/**
 * BFF route test: PATCH /api/links/[id].
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { PATCH } from '@/app/api/links/[id]/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PATCH /api/links/[id]', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the patch body to the encoded id path', async () => {
    mockCallApi.mockResolvedValue(
      jsonResponse(200, { id: '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}', label: 'Updated' }),
    );
    const req = new Request('http://localhost/api/links/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'Updated' }),
    });
    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}' }),
    });
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith(
      '/v1/links/%7Ba0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11%7D',
      {
        method: 'PATCH',
        body: { label: 'Updated' },
      },
    );
  });

  it('returns 400 on malformed JSON body', async () => {
    const req = new Request('http://localhost/api/links/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', {
      method: 'PATCH',
      body: 'not json',
    });
    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('passes through a 409 when the link is not editable', async () => {
    mockCallApi.mockResolvedValue(jsonResponse(409, { error: { code: 'LINK_NOT_DRAFT' } }));
    const req = new Request('http://localhost/api/links/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('LINK_NOT_DRAFT');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const req = new Request('http://localhost/api/links/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const req = new Request('http://localhost/api/links/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', {
      method: 'PATCH',
      body: JSON.stringify({ label: 'x' }),
    });
    const res = await PATCH(req as never, {
      params: Promise.resolve({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('PATCH /api/links/[id] id check', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(['l1', 'not-a-uuid', '../../v1/admin', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a1'])(
    'returns the 404 NOT_FOUND envelope for %j without calling upstream',
    async (id) => {
      const res = await PATCH(
        new NextRequest('http://localhost/x', {
          method: 'PATCH',
          body: JSON.stringify({ slug: 'x' }),
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
    const res = await PATCH(
      new NextRequest('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({ slug: 'x' }),
      }),
      {
        params: Promise.resolve({ id: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' }),
      },
    );
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledTimes(1);
  });
});
