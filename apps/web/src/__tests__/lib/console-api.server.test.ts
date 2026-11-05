import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

const { logError, logWarn } = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: logError, warn: logWarn } }));

import { z } from 'zod';
import { consoleRead, consoleReadOptional } from '@/lib/console-api.server';
import { ResponseShapeError } from '@/lib/response-shape-error';
import { callApi } from '@/lib/upstream-client';
import { redirect, notFound } from 'next/navigation';

const OrgSchema = z.object({ id: z.string() });
const SearchSchema = z.object({ results: z.array(z.unknown()) });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('consoleRead (console-api.server)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads a resource with GET when no body is given', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 'org-1' }));
    await expect(consoleRead('/v1/org/read/org-1', OrgSchema)).resolves.toEqual({ id: 'org-1' });
    expect(callApi).toHaveBeenCalledWith('/v1/org/read/org-1', { method: 'GET' });
  });

  it('reads with a POST (search) when a body is given', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ results: [] }));
    await expect(consoleRead('/v1/org/search', SearchSchema, { q: 'x' })).resolves.toEqual({
      results: [],
    });
    expect(callApi).toHaveBeenCalledWith('/v1/org/search', { method: 'POST', body: { q: 'x' } });
  });

  it('redirects to login when callApi throws (no session)', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('no active session'));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow(
      'REDIRECT:/api/auth/login?returnTo=/console',
    );
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=/console');
  });

  it('redirects to login on 401', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 401));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow(
      'REDIRECT:/api/auth/login?returnTo=/console',
    );
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=/console');
  });

  it('calls notFound on 404', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 404));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('logs out with console_not_provisioned on 403 USER_NOT_PROVISIONED', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'USER_NOT_PROVISIONED' } }, 403));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow(
      'REDIRECT:/api/auth/logout?reason=console_not_provisioned',
    );
  });

  it('logs out with console_no_org on 403 NOT_ORG_ADMIN', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'NOT_ORG_ADMIN' } }, 403));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow(
      'REDIRECT:/api/auth/logout?reason=console_no_org',
    );
  });

  it('redirects to /console on 403 with any other code', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ error: { code: 'SOMETHING_ELSE' } }, 403));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow('REDIRECT:/console');
    expect(redirect).toHaveBeenCalledWith('/console');
  });

  it('redirects to /console on 403 with an unparseable body', async () => {
    vi.mocked(callApi).mockResolvedValue(
      new Response('not json', { status: 403, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow('REDIRECT:/console');
    expect(redirect).toHaveBeenCalledWith('/console');
  });

  it('throws on any other non-ok status', async () => {
    vi.mocked(callApi).mockResolvedValue(json({}, 500));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toThrow(
      'console read failed (500)',
    );
  });

  it('returns the schema output, without keys the schema does not declare', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 'org-1', extra: 'x' }));
    await expect(consoleRead('/v1/org/read/org-1', OrgSchema)).resolves.toEqual({ id: 'org-1' });
  });

  it('throws ResponseShapeError and logs paths only when the body does not match', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 42, name: 'Private Name' }));
    const error: unknown = await consoleRead('/v1/org/read/x', OrgSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'consoleRead',
        status: 'failure',
        path: '/v1/org/read/x',
        issues: [{ path: 'id', code: 'invalid_type' }],
      }),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain('Private Name');
  });

  it('throws ResponseShapeError when an OK body is not JSON', async () => {
    vi.mocked(callApi).mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(consoleRead('/v1/org/read/x', OrgSchema)).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
  });
});

describe('consoleReadOptional (console-api.server)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the parsed body', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 'org-1' }));
    await expect(consoleReadOptional('/v1/roles', OrgSchema)).resolves.toEqual({ id: 'org-1' });
  });

  it.each([
    ['a non-ok status', () => json({}, 503)],
    ['a body of the wrong shape', () => json({ id: 42 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
  ])('returns null for %s', async (_label, response) => {
    vi.mocked(callApi).mockResolvedValue(response());
    await expect(consoleReadOptional('/v1/roles', OrgSchema)).resolves.toBeNull();
  });

  it('returns null when callApi throws', async () => {
    vi.mocked(callApi).mockRejectedValue(new Error('no session'));
    await expect(consoleReadOptional('/v1/roles', OrgSchema)).resolves.toBeNull();
  });

  it('logs a warning with paths only when the body does not match', async () => {
    vi.mocked(callApi).mockResolvedValue(json({ id: 42, name: 'Private Name' }));
    await consoleReadOptional('/v1/roles', OrgSchema);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'consoleReadOptional',
        status: 'failure',
        path: '/v1/roles',
        issues: [{ path: 'id', code: 'invalid_type' }],
      }),
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('Private Name');
  });
});
