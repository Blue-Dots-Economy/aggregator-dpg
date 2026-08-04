import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMock = vi.fn();
vi.mock('@/lib/server-session', () => ({ getSession: getSessionMock }));

const { requireSession, UnauthorizedError } = await import('@/lib/auth-helpers');

describe('UnauthorizedError', () => {
  it('carries a ready-to-return 401 NextResponse', async () => {
    const err = new UnauthorizedError();
    expect(err.message).toBe('unauthorized');
    expect(err.response.status).toBe(401);
    const body = (await err.response.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });
});

describe('requireSession', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('returns the active session when present', async () => {
    const session = { sub: 'user-1' };
    getSessionMock.mockResolvedValueOnce(session);
    await expect(requireSession()).resolves.toBe(session);
  });

  it('throws UnauthorizedError when no session exists', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    await expect(requireSession()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
