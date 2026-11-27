import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
const { callApi } = vi.hoisted(() => ({ callApi: vi.fn() }));
vi.mock('@/lib/upstream-client', () => ({ callApi }));

import { readOpenInvites } from '@/lib/console-invites.server';

const page = {
  invites: [
    {
      email: 'a@x.org',
      status: 'pending',
      created_at: '2026-11-01T00:00:00Z',
      expires_at: '2026-11-15T00:00:00Z',
    },
  ],
  next_cursor: null,
};

describe('readOpenInvites', () => {
  beforeEach(() => callApi.mockReset());

  it('reads coordinator invites by org_id and org invites by parent_id', async () => {
    callApi.mockImplementation(async () => new Response(JSON.stringify(page), { status: 200 }));
    expect(await readOpenInvites('user', 'o1')).toEqual(page);
    expect(await readOpenInvites('org', 'o1')).toEqual(page);
    expect(callApi).toHaveBeenNthCalledWith(1, '/v1/user/invite/search', {
      method: 'POST',
      body: { org_id: 'o1', limit: 100 },
    });
    expect(callApi).toHaveBeenNthCalledWith(2, '/v1/org/invite/search', {
      method: 'POST',
      body: { parent_id: 'o1', limit: 100 },
    });
  });

  it('leaves the list out on a refusal, a bad body or no session', async () => {
    callApi.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await readOpenInvites('user', 'o1')).toBeNull();
    callApi.mockResolvedValueOnce(new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await readOpenInvites('user', 'o1')).toBeNull();
    callApi.mockRejectedValueOnce(new Error('no active session'));
    expect(await readOpenInvites('user', 'o1')).toBeNull();
  });
});
