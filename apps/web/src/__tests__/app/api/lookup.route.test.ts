/**
 * BFF route test: GET /api/[org]/[slug]/lookup.
 *
 * Asserts that the route proxies upstream responses verbatim, forwards
 * the originating client signals (xff, user-agent, request id) to the
 * aggregator API, and surfaces a 503 when the upstream fetch fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/[org]/[slug]/lookup/route';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('GET /api/[org]/[slug]/lookup', () => {
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

  it('proxies the upstream owned_elsewhere response verbatim', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ user_exists: true, owned_elsewhere: true, lifecycle_summary: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
    const req = new Request(
      'http://localhost/api/acme/winter25/lookup?email=foreign%40x.com&network=blue_dot&domain=seeker',
    );
    // Cast — NextRequest extends Request; the route only touches Request members.
    const res = await GET(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owned_elsewhere?: boolean };
    expect(body.owned_elsewhere).toBe(true);
  });

  it('forwards the search params and request id to the upstream URL', async () => {
    const calls: { url: string; init: FetchInit }[] = [];
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return new Response(
        JSON.stringify({ user_exists: false, owned_elsewhere: false, lifecycle_summary: null }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const req = new Request(
      'http://localhost/api/acme/winter25/lookup?email=new%40x.com&network=blue_dot&domain=seeker',
      { headers: { 'x-request-id': 'req-test-123', 'x-forwarded-for': '10.0.0.5' } },
    );
    const res = await GET(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('http://api.test/public/v1/aggregators/acme/lookup?');
    expect(calls[0]!.url).toContain('email=new%40x.com');
    expect(calls[0]!.url).toContain('network=blue_dot');
    expect(calls[0]!.url).toContain('domain=seeker');
    const headers = (calls[0]!.init as { headers?: Record<string, string> }).headers ?? {};
    expect(headers['x-request-id']).toBe('req-test-123');
    expect(headers['x-forwarded-for']).toBe('10.0.0.5');
    // Mirror back through the response header for client correlation.
    expect(res.headers.get('x-request-id')).toBe('req-test-123');
  });

  it('returns 503 when the upstream fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const req = new Request(
      'http://localhost/api/acme/winter25/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    );
    const res = await GET(req as never, {
      params: Promise.resolve({ org: 'acme', slug: 'winter25' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('GET /api/[org]/[slug]/lookup query check', () => {
  let originalFetch: typeof fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ user_exists: false, owned_elsewhere: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const params = { params: Promise.resolve({ org: 'acme', slug: 'winter25' }) };

  it.each([
    [
      '?email=%20a%40b.com%20&network=blue_dot&domain=seeker',
      '?email=+a%40b.com+&network=blue_dot&domain=seeker',
    ],
    ['?phone_number=%2B91 98&network=n&domain=d', '?phone_number=%2B91+98&network=n&domain=d'],
    [
      '?email=a%40b.com&phone_number=1&network=n&domain=d&extra=1',
      '?email=a%40b.com&phone_number=1&network=n&domain=d',
    ],
  ])('forwards %j as %j', async (query, forwarded) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/acme/winter25/lookup${query}`),
      params,
    );
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      new RegExp(`/public/v1/aggregators/acme/lookup${forwarded.replace(/[?+]/g, '\\$&')}$`),
    );
  });

  it.each([
    '',
    '?network=n&domain=d',
    '?email=not-an-email&network=n&domain=d',
    '?phone_number=%20&network=n&domain=d',
    '?email=a%40b.com&domain=d',
    '?email=a%40b.com&network=%20&domain=d',
    '?email=a%40b.com&network=n',
  ])('rejects %j with 400 without calling upstream', async (query) => {
    const res = await GET(
      new NextRequest(`http://localhost/api/acme/winter25/lookup${query}`),
      params,
    );
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ error: { code: 'SCHEMA_VALIDATION' } });
    expect(JSON.stringify(body)).not.toContain('not-an-email');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
