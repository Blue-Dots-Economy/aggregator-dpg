import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { org } from '../components/console/fixtures';
import {
  errorKey,
  getConsole,
  RESPONSE_SHAPE_CODE,
  sendConsole,
  setOrgKnownAs,
  setOrgKnownAsValues,
} from '@/lib/console-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sendConsole (console-client)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  const IdSchema = z.object({ id: z.string() });

  it('sends JSON same-origin and returns ok with the parsed data', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: 'u1', extra: 1 }));
    const res = await sendConsole('/api/console/user/decision/u1', 'POST', IdSchema, {
      decision: 'approve',
    });
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
    const res = await sendConsole('/api/console/user/x', 'PATCH', IdSchema, {});
    expect(res).toEqual({ ok: false, status: 0, error: {} });
  });

  it('returns RESPONSE_SHAPE and logs paths only when an OK body does not match', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(global.fetch).mockResolvedValue(json({ id: 7, name: 'Private' }));
    const res = await sendConsole('/api/console/user/x', 'PATCH', IdSchema, {});
    expect(res).toEqual({ ok: false, status: 200, error: { code: RESPONSE_SHAPE_CODE } });
    expect(JSON.stringify(logged.mock.calls)).toContain('"path":"id"');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('Private');
  });

  it('returns RESPONSE_SHAPE when an OK body is not JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(global.fetch).mockResolvedValue(new Response('<html>', { status: 200 }));
    const res = await sendConsole('/api/console/user/x', 'PATCH', IdSchema, {});
    expect(res).toEqual({ ok: false, status: 200, error: { code: RESPONSE_SHAPE_CODE } });
  });

  it('returns the error envelope on a non-ok response', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'ORG_NAME_TAKEN' } }, 409));
    const res = await sendConsole('/api/console/org/x', 'POST', z.unknown(), {});
    expect(res).toEqual({ ok: false, status: 409, error: { code: 'ORG_NAME_TAKEN' } });
  });

  it('falls back to an empty error when the error field is not an object', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: 'nope' }, 400));
    const res = await sendConsole('/api/console/org/x', 'POST', z.unknown(), {});
    expect(res).toEqual({ ok: false, status: 400, error: {} });
  });

  it('falls back to an empty error when the body is not JSON', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await sendConsole('/api/console/org/x', 'POST', z.unknown(), {});
    expect(res).toEqual({ ok: false, status: 500, error: {} });
  });
});

describe('console error bodies (console-client)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the code and fields of an error', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ error: { code: 'CONFLICT', fields: { reason: 'busy' }, message: 'x' } }, 409),
    );
    const res = await sendConsole('/api/console/org/x', 'POST', z.unknown(), {});
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: { code: 'CONFLICT', fields: { reason: 'busy' } },
    });
  });

  it('drops a code or fields of the wrong type', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ error: { code: 42, fields: ['reason'] } }, 400),
    );
    const res = await sendConsole('/api/console/org/x', 'POST', z.unknown(), {});
    expect(res).toEqual({ ok: false, status: 400, error: {} });
  });
});

describe('getConsole (console-client)', () => {
  const OptionsSchema = z.object({ options: z.array(z.object({ id: z.string() })) });

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads same-origin and returns the parsed body', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ options: [{ id: 'o1', extra: 1 }] }));
    const res = await getConsole('/api/console/org/parent/options/x', OptionsSchema);
    expect(res).toEqual({ ok: true, status: 200, data: { options: [{ id: 'o1' }] } });
    expect(global.fetch).toHaveBeenCalledWith('/api/console/org/parent/options/x', {
      credentials: 'same-origin',
    });
  });

  it('returns RESPONSE_SHAPE and logs paths only when an OK body does not match', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(global.fetch).mockResolvedValue(json({ options: [{ id: 7, name: 'Private' }] }));
    const res = await getConsole('/api/console/org/parent/options/x', OptionsSchema);
    expect(res).toEqual({ ok: false, status: 200, error: { code: 'RESPONSE_SHAPE' } });
    expect(JSON.stringify(logged.mock.calls)).toContain('options.0.id');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('Private');
  });

  it('returns the error of a failed read', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'NOT_FOUND' } }, 404));
    const res = await getConsole('/api/console/org/parent/options/x', OptionsSchema);
    expect(res).toEqual({ ok: false, status: 404, error: { code: 'NOT_FOUND' } });
  });

  it('returns status 0 when fetch throws', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new TypeError('network down'));
    const res = await getConsole('/api/console/org/parent/options/x', OptionsSchema);
    expect(res).toEqual({ ok: false, status: 0, error: {} });
  });
});

describe('known_as calls (console-client)', () => {
  const ID = '00000000-0000-4000-8000-0000000000e1';
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('setOrgKnownAs sends the key to the known-as route', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json(org({ id: ID, known_as: 'district' })));
    const res = await setOrgKnownAs(ID, 'district');
    expect(res.ok && res.data.known_as).toBe('district');
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ID}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ known_as: 'district' }) }),
    );
  });

  it('setOrgKnownAsValues sends the list to the known-as route', async () => {
    const saved = [
      { key: 'district', name: 'District' },
      { key: 'block', name: 'Block', default: true as const },
    ];
    vi.mocked(global.fetch).mockResolvedValue(json({ ...org({ id: ID }), known_as_values: saved }));
    const values = [
      { key: 'district', name: 'District' },
      { name: 'Block', default: true as const },
    ];
    const res = await setOrgKnownAsValues(ID, values);
    expect(res.ok && res.data.known_as_values).toEqual(saved);
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ known_as_values: values }),
      }),
    );
  });

  it('setOrgKnownAsValues returns RESPONSE_SHAPE when the saved list is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(global.fetch).mockResolvedValue(json(org({ id: ID })));
    const res = await setOrgKnownAsValues(ID, []);
    expect(res).toEqual({ ok: false, status: 200, error: { code: RESPONSE_SHAPE_CODE } });
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
  it.each([
    ['ORG_DEPTH_LIMIT', 409, 'errors.depth_limit'],
    ['ORG_CHILD_LIMIT', 409, 'errors.child_limit'],
    ['ORG_TOTAL_LIMIT', 409, 'errors.total_limit'],
    ['ORG_PARENT_CYCLE', 400, 'errors.parent_cycle'],
  ])('maps %s', (code, status, key) => {
    expect(errorKey({ status, error: { code } })).toBe(key);
  });
  it('maps a CONFLICT by its reason', () => {
    expect(errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'busy' } } })).toBe(
      'errors.busy',
    );
    expect(
      errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'not_movable' } } }),
    ).toBe('errors.not_movable');
    expect(
      errorKey({ status: 409, error: { code: 'CONFLICT', fields: { reason: 'moved' } } }),
    ).toBe('errors.org_moved');
    expect(errorKey({ status: 409, error: { code: 'CONFLICT' } })).toBe('errors.generic');
  });
  it('maps an invalid parent or known-as field', () => {
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { parent_id: 'invalid' } },
      }),
    ).toBe('errors.parent_invalid');
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { known_as: 'invalid' } },
      }),
    ).toBe('errors.known_as_invalid');
  });
  it('maps a known-as list key that is not saved to known_as_values_changed', () => {
    expect(
      errorKey({
        status: 400,
        error: { code: 'SCHEMA_VALIDATION', fields: { known_as_values: 'unknown_key', index: 1 } },
      }),
    ).toBe('errors.known_as_values_changed');
  });
  it.each([
    [0, 'errors.network'],
    [401, 'errors.signed_out'],
    [403, 'errors.forbidden'],
    [500, 'errors.server'],
    [503, 'errors.server'],
  ])('maps status %i to a plain message', (status, key) => {
    expect(errorKey({ status, error: {} })).toBe(key);
  });

  it('maps RESPONSE_SHAPE to response_shape', () => {
    expect(errorKey({ status: 200, error: { code: RESPONSE_SHAPE_CODE } })).toBe(
      'errors.response_shape',
    );
  });

  it('falls back to generic', () => {
    expect(errorKey({ status: 400, error: { code: 'OTHER' } })).toBe('errors.generic');
    expect(errorKey({ status: 400, error: {} })).toBe('errors.generic');
  });
});
