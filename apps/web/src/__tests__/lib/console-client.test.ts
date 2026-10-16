import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendConsole, errorKey } from '@/lib/console-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sendConsole (console-client)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends JSON same-origin and returns ok with data', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: 'u1' }));
    const res = await sendConsole('/api/console/user/decision/u1', 'POST', { decision: 'approve' });
    expect(res).toEqual({ ok: true, status: 200, data: { id: 'u1' } });
    expect(global.fetch).toHaveBeenCalledWith('/api/console/user/decision/u1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ decision: 'approve' }),
    });
  });

  it('returns status 0 when fetch throws', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new TypeError('network down'));
    const res = await sendConsole('/api/console/user/x', 'PATCH', {});
    expect(res).toEqual({ ok: false, status: 0, error: {} });
  });

  it('returns the error envelope on a non-ok response', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'ORG_NAME_TAKEN' } }, 409));
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 409, error: { code: 'ORG_NAME_TAKEN' } });
  });

  it('falls back to an empty error when the error field is not an object', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: 'nope' }, 400));
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 400, error: {} });
  });

  it('falls back to an empty error when the body is not JSON', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await sendConsole('/api/console/org/x', 'POST', {});
    expect(res).toEqual({ ok: false, status: 500, error: {} });
  });
});

describe('errorKey (console-client)', () => {
  it('maps 429 to rate_limited', () => {
    expect(errorKey({ status: 429, error: {} })).toBe('errors.rate_limited');
  });
  it('maps 404 to not_found', () => {
    expect(errorKey({ status: 404, error: {} })).toBe('errors.not_found');
  });
  it('maps ORG_NAME_TAKEN to name_taken', () => {
    expect(errorKey({ status: 409, error: { code: 'ORG_NAME_TAKEN' } })).toBe('errors.name_taken');
  });
  it('falls back to generic', () => {
    expect(errorKey({ status: 400, error: { code: 'OTHER' } })).toBe('errors.generic');
    expect(errorKey({ status: 400, error: {} })).toBe('errors.generic');
  });
});
