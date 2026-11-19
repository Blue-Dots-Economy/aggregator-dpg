/**
 * BFF route test: GET /api/links/voice-bots.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/upstream-client', () => ({
  callApi: vi.fn(),
}));

import { GET } from '@/app/api/links/voice-bots/route';
import { callApi } from '@/lib/upstream-client';

const mockCallApi = vi.mocked(callApi);

describe('GET /api/links/voice-bots', () => {
  afterEach(() => vi.clearAllMocks());

  it('forwards the domain query', async () => {
    mockCallApi.mockResolvedValue(
      new Response(JSON.stringify({ voice_bots: [], default_voice_bot_key: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await GET(new NextRequest('http://localhost/api/links/voice-bots?domain=seeker'));
    expect(res.status).toBe(200);
    expect(mockCallApi).toHaveBeenCalledWith('/v1/links/voice-bots?domain=seeker', {
      method: 'GET',
    });
  });

  it('returns 400 when domain is missing', async () => {
    const res = await GET(new NextRequest('http://localhost/api/links/voice-bots'));
    expect(res.status).toBe(400);
    expect(mockCallApi).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no active session', async () => {
    mockCallApi.mockRejectedValue(new Error('no active session'));
    const res = await GET(new NextRequest('http://localhost/api/links/voice-bots?domain=seeker'));
    expect(res.status).toBe(401);
  });
});
