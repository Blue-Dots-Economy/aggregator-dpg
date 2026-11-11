import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { HttpError, jsonFetch, retryUnlessShapeError } from '../http';

const HelloSchema = z.object({ hello: z.string() });
const AnySchema = z.unknown();

describe('jsonFetch', () => {
  const origFetch = globalThis.fetch;
  const origLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '', pathname: '/dashboard', search: '' } as Location,
    });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: origLocation,
    });
  });

  it('sets JSON headers, includes credentials, and parses the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const data = await jsonFetch('/api/thing', HelloSchema);
    expect(data).toEqual({ hello: 'world' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });

  it('preserves caller-supplied headers alongside the defaults', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await jsonFetch('/api/thing', AnySchema, { headers: { 'X-Custom': 'abc' } });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('abc');
  });

  it('throws with status + text on a non-OK, non-401 response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('boom', { status: 500, statusText: 'Server Error' }),
      ) as unknown as typeof fetch;
    // CI on Node 24 / JSDOM 25 sometimes empties template-string error
    // messages; assert that the call throws rather than match the text.
    await expect(jsonFetch('/api/thing', AnySchema)).rejects.toThrow();
  });

  it('throws an HttpError with the status and the API error code, without the body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'DOMAIN_NOT_SERVED',
            detail: 'Your account does not serve this profile type.',
          },
        }),
        { status: 403 },
      ),
    ) as unknown as typeof fetch;
    const err = await jsonFetch('/api/thing', AnySchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 403, code: 'DOMAIN_NOT_SERVED' });
    expect(String((err as Error).message)).not.toContain('profile type');
  });

  it('throws an HttpError with no code when the body is not the API error shape', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('<html>bad gateway</html>', { status: 502 }),
      ) as unknown as typeof fetch;
    const err = await jsonFetch('/api/thing', AnySchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 502, code: undefined });
    expect(String((err as Error).message)).not.toContain('bad gateway');
  });

  it('force-logs-out on a 401 NO_ACTIVE_SESSION body and throws session expired', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'NO_ACTIVE_SESSION' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', AnySchema)).rejects.toThrow();
    expect(window.location.href).toContain('/api/auth/logout?reason=expired');
  });

  it('treats a 401 with a different body shape as a normal error, not a forced logout', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', AnySchema)).rejects.toThrow();
    expect(window.location.href).toBe('');
  });

  it('treats a 401 with a non-JSON body as a normal error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('not json', { status: 401 })) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', AnySchema)).rejects.toThrow();
  });

  it('skips the forced logout when already on the login/auth flow', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, href: '', pathname: '/login', search: '' } as Location,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'NO_ACTIVE_SESSION' }), { status: 401 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', AnySchema)).rejects.toThrow();
    expect(window.location.href).toBe('');
  });

  it('drops fields the schema does not declare', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ hello: 'world', extra: 1 }), { status: 200 }),
      ) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', HelloSchema)).resolves.toEqual({ hello: 'world' });
  });

  it('throws ResponseShapeError when a required field is missing', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ other: 1 }), { status: 200 }),
      ) as unknown as typeof fetch;
    const err = await jsonFetch('/api/thing', HelloSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect(err).toMatchObject({ url: '/api/thing' });
    expect(err instanceof ResponseShapeError && err.issues[0]?.path).toEqual(['hello']);
  });

  it('throws ResponseShapeError when an OK body is not JSON', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(jsonFetch('/api/thing', HelloSchema)).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('summarises shape issues by field path and code, without the received values', async () => {
    const StatusSchema = z.object({ status: z.enum(['draft', 'live']), count: z.number() });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'secret-value', count: 'x' }), { status: 200 }),
      ) as unknown as typeof fetch;
    const err = await jsonFetch('/api/thing', StatusSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    const summary = err instanceof ResponseShapeError ? err.issueSummary() : [];
    expect(summary).toEqual([
      { path: 'status', code: 'invalid_enum_value' },
      { path: 'count', code: 'invalid_type' },
    ]);
    expect(JSON.stringify(summary)).not.toContain('secret-value');
  });
});

describe('retryUnlessShapeError', () => {
  it('retries a failed request once', () => {
    expect(retryUnlessShapeError(0, new Error('network down'))).toBe(true);
    expect(retryUnlessShapeError(1, new Error('network down'))).toBe(false);
  });

  it('never retries a shape error, which would fail again', () => {
    expect(retryUnlessShapeError(0, new ResponseShapeError('/api/thing', []))).toBe(false);
  });
});
