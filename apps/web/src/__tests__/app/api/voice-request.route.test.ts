/**
 * BFF route test: POST /api/[org]/[slug]/voice-request.
 *
 * Anonymous proxy to the public voice-request endpoint. Mirrors the submit
 * proxy: body forwarding, size cap, malformed JSON, 503 upstream mapping and
 * status pass-through (including `Retry-After` on a 429).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/[org]/[slug]/voice-request/route';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const PARAMS = { params: Promise.resolve({ org: 'acme', slug: 'winter25' }) };

describe('POST /api/[org]/[slug]/voice-request', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
  });

  it('forwards the body to the upstream voice-requests endpoint', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(
        JSON.stringify({
          existing: false,
          voice_bot: { display_name: 'Bot', phone: '+91', languages: ['hi'] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const req = new Request('http://localhost/api/acme/winter25/voice-request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-abc',
        'x-forwarded-for': '198.51.100.66, 10.0.0.9',
        'user-agent': 'vitest',
      },
      body: JSON.stringify({ phone: '9876543210' }),
    });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { existing?: boolean };
    expect(body.existing).toBe(false);

    expect(calls[0]!.url).toBe(
      'http://api.test/public/v1/aggregators/acme/voice-requests/winter25',
    );
    const init = calls[0]!.init as { headers?: Record<string, string>; body?: string };
    expect(init.headers?.['x-request-id']).toBe('req-abc');
    expect(init.headers?.['x-forwarded-for']).toBe('10.0.0.9');
    expect(init.headers?.['user-agent']).toBe('vitest');
    expect(JSON.parse(init.body ?? '{}')).toEqual({ phone: '9876543210' });
    expect(res.headers.get('x-request-id')).toBe('req-abc');
  });

  it('passes a 409 error body through', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'VOICE_BOT_UNAVAILABLE' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const req = new Request('http://localhost/x', { method: 'POST', body: '{}' });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VOICE_BOT_UNAVAILABLE');
  });

  it('keeps the Retry-After header on a 429', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    ) as unknown as typeof fetch;
    const req = new Request('http://localhost/x', { method: 'POST', body: '{}' });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('returns 400 BAD_JSON on malformed body', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', body: 'not json' });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('BAD_JSON');
  });

  it('returns 413 PAYLOAD_TOO_LARGE when the body exceeds the byte cap', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ blob: 'x'.repeat(32_100) }),
    });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 503 UPSTREAM_UNAVAILABLE when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const req = new Request('http://localhost/x', { method: 'POST', body: '{}' });
    const res = await POST(req as never, PARAMS);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});
