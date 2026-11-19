/**
 * Unit tests for the shared public-link proxy plumbing (`lib/public-proxy.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  forwardJsonPost,
  PUBLIC_BODY_MAX_BYTES,
  proxyError,
  proxyToPublicApi,
  readJsonBody,
  requestIdOf,
  REQUEST_ID_HEADER,
} from '@/lib/public-proxy';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const TITLE = 'Too big';

interface Envelope {
  error: { code: string; title: string; detail: string; requestId: string; timestamp: string };
}

function postReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/x', { method: 'POST', body, headers });
}

describe('requestIdOf', () => {
  it('returns the caller request id', () => {
    const req = new Request('http://localhost/x', { headers: { [REQUEST_ID_HEADER]: 'req-1' } });
    expect(requestIdOf(req)).toBe('req-1');
  });

  it('generates one when none is sent', () => {
    expect(requestIdOf(new Request('http://localhost/x'))).toMatch(/^req-[0-9a-f-]{36}$/);
  });
});

describe('proxyError', () => {
  it('builds the envelope and echoes the request id', async () => {
    const res = proxyError(418, 'CODE', 'Title', 'Detail', 'req-9');
    expect(res.status).toBe(418);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('req-9');
    const body = (await res.json()) as Envelope;
    expect(body.error).toMatchObject({
      code: 'CODE',
      title: 'Title',
      detail: 'Detail',
      requestId: 'req-9',
    });
    expect(Number.isNaN(Date.parse(body.error.timestamp))).toBe(false);
  });
});

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    const result = await readJsonBody(postReq('{"a":1}'), 'r', TITLE);
    expect(result).toEqual({ ok: true, body: { a: 1 } });
  });

  it('treats an empty body as {}', async () => {
    const result = await readJsonBody(postReq(''), 'r', TITLE);
    expect(result).toEqual({ ok: true, body: {} });
  });

  it('accepts a body exactly at the cap', async () => {
    const body = 'x'.repeat(PUBLIC_BODY_MAX_BYTES - 2);
    const result = await readJsonBody(postReq(`"${body}"`), 'r', TITLE);
    expect(result).toEqual({ ok: true, body });
  });

  it('answers 413 with the route title past the cap', async () => {
    const result = await readJsonBody(
      postReq(`"${'x'.repeat(PUBLIC_BODY_MAX_BYTES)}"`),
      'r',
      TITLE,
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(413);
    const body = (await result.response.json()) as Envelope;
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.title).toBe('Too big');
  });

  it('answers 400 BAD_JSON for malformed JSON', async () => {
    const result = await readJsonBody(postReq('{bad'), 'r', TITLE);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
    expect(((await result.response.json()) as Envelope).error.code).toBe('BAD_JSON');
  });

  it('answers 400 BAD_REQUEST when the body cannot be read', async () => {
    const req = postReq('{}');
    vi.spyOn(req, 'text').mockRejectedValue(new Error('stream broke'));
    const result = await readJsonBody(req, 'r', TITLE);
    if (result.ok) throw new Error('expected failure');
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as Envelope;
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.detail).toBe('stream broke');
  });
});

describe('proxyToPublicApi', () => {
  let originalFetch: typeof fetch;
  let originalApiBase: string | undefined;
  let calls: { url: string; init: FetchInit }[];

  function stubFetch(response: () => Response): void {
    globalThis.fetch = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      calls.push({ url: input.toString(), init: init ?? null });
      return response();
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiBase = process.env.API_BASE_URL;
    process.env.API_BASE_URL = 'http://api.test';
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBase;
  });

  it('sends a JSON POST with the forwarding headers', async () => {
    stubFetch(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const req = postReq('', {
      'x-forwarded-for': '198.51.100.1, 10.0.0.9',
      'user-agent': 'vitest',
    });
    const res = await proxyToPublicApi(req, 'req-1', {
      method: 'POST',
      path: '/public/v1/x',
      body: { a: 1 },
      unavailableDetail: 'down',
    });

    expect(calls[0]!.url).toBe('http://api.test/public/v1/x');
    const init = calls[0]!.init as {
      method: string;
      headers: Record<string, string>;
      body?: string;
      cache?: string;
    };
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      [REQUEST_ID_HEADER]: 'req-1',
      'x-forwarded-for': '10.0.0.9',
      'user-agent': 'vitest',
    });
    expect(init.body).toBe('{"a":1}');
    expect(init.cache).toBeUndefined();
    expect(res.status).toBe(201);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('req-1');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('sends a no-store GET with a JSON accept and no body', async () => {
    stubFetch(() => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    await proxyToPublicApi(new Request('http://localhost/x'), 'req-2', {
      method: 'GET',
      path: '/public/v1/y?q=1',
      unavailableDetail: 'down',
    });
    const init = calls[0]!.init as {
      method: string;
      headers: Record<string, string>;
      body?: string;
      cache?: string;
    };
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', [REQUEST_ID_HEADER]: 'req-2' });
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });

  it('relays a non-JSON body with its content type', async () => {
    stubFetch(
      () => new Response('slow down', { status: 429, headers: { 'content-type': 'text/html' } }),
    );
    const res = await proxyToPublicApi(new Request('http://localhost/x'), 'req-3', {
      method: 'GET',
      path: '/p',
      unavailableDetail: 'down',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('req-3');
    expect(await res.text()).toBe('slow down');
  });

  it('keeps Retry-After only when asked', async () => {
    const limited = (): Response =>
      new Response('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      });
    stubFetch(limited);
    const call = { method: 'GET' as const, path: '/p', unavailableDetail: 'down' };
    const dropped = await proxyToPublicApi(new Request('http://localhost/x'), 'r', call);
    expect(dropped.headers.get('retry-after')).toBeNull();
    const kept = await proxyToPublicApi(new Request('http://localhost/x'), 'r', {
      ...call,
      passRetryAfter: true,
    });
    expect(kept.headers.get('retry-after')).toBe('30');
  });

  it('answers 503 UPSTREAM_UNAVAILABLE when the API cannot be reached', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await proxyToPublicApi(new Request('http://localhost/x'), 'req-4', {
      method: 'GET',
      path: '/p',
      unavailableDetail: 'down',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.error.detail).toBe('ECONNREFUSED');
    expect(body.error.requestId).toBe('req-4');
  });

  it('uses the fallback detail when the failure is not an Error', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject('boom')) as unknown as typeof fetch;
    const res = await proxyToPublicApi(new Request('http://localhost/x'), 'r', {
      method: 'GET',
      path: '/p',
      unavailableDetail: 'Could not reach it.',
    });
    expect(((await res.json()) as Envelope).error.detail).toBe('Could not reach it.');
  });
});

describe('forwardJsonPost', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the body error without calling the API', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const res = await forwardJsonPost(postReq('{bad', { [REQUEST_ID_HEADER]: 'req-5' }), {
      path: '/p',
      tooLargeTitle: TITLE,
      unavailableDetail: 'down',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('req-5');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the parsed body under the caller request id', async () => {
    const calls: FetchInit[] = [];
    globalThis.fetch = vi.fn(async (_input: FetchInput, init?: FetchInit) => {
      calls.push(init ?? null);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const res = await forwardJsonPost(postReq('{"a":1}', { [REQUEST_ID_HEADER]: 'req-6' }), {
      path: '/p',
      tooLargeTitle: TITLE,
      unavailableDetail: 'down',
    });
    const init = calls[0] as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers[REQUEST_ID_HEADER]).toBe('req-6');
    expect(res.status).toBe(200);
  });
});
