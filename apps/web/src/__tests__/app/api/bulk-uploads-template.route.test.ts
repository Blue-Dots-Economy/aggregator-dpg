/**
 * BFF route test: GET /api/bulk-uploads/template.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/bulk-uploads/template/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/bulk-uploads/template', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the CSV template with content-type/disposition preserved', async () => {
    mockCallApi.mockResolvedValue(
      new Response('name,email\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="seeker_template.csv"',
        },
      }),
    );
    const res = await GET(
      new NextRequest(
        'http://localhost/api/bulk-uploads/template?participant_type=seeker',
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="seeker_template.csv"',
    );
    expect(await res.text()).toBe('name,email\n');
    expect(mockCallApi).toHaveBeenCalledWith('/v1/bulk-uploads/template?participant_type=seeker', {
      method: 'GET',
    });
  });

  it('falls back to a default filename/content-type when upstream omits them', async () => {
    const upstream = new Response('name,email\n', { status: 200 });
    upstream.headers.delete('content-type');
    mockCallApi.mockResolvedValue(upstream);
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="template.csv"');
  });

  it('returns the upstream error body verbatim on a non-2xx response', async () => {
    mockCallApi.mockResolvedValue(new Response('bad participant_type', { status: 400 }));
    const res = await GET(
      new NextRequest('http://localhost/api/bulk-uploads/template?participant_type=bogus') as never,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('bad participant_type');
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when the upstream call throws', async () => {
    mockCallApi.mockRejectedValue(new Error('timeout'));
    const res = await GET(new NextRequest('http://localhost/api/bulk-uploads/template'));
    expect(res.status).toBe(503);
  });
});
