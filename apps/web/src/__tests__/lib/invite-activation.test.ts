import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { activateInvitee } from '@/lib/invite-activation';
import { logger } from '@/lib/logger';

describe('activateInvitee', () => {
  let originalFetch: typeof fetch;
  let seen: { url: string; auth: string | null }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.API_BASE_URL = 'http://api.test';
    seen = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(status: number, body: unknown): void {
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        url: input.toString(),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  it('posts to activate with the new access token', async () => {
    respond(200, { status: 'active', account: 'org_owner', activated: true });
    expect(await activateInvitee('tok-1', logger)).toBe('active');
    expect(seen).toEqual([{ url: 'http://api.test/v1/user/activate', auth: 'Bearer tok-1' }]);
  });

  it('reports an unverified email', async () => {
    respond(403, { error: { code: 'EMAIL_NOT_VERIFIED' } });
    expect(await activateInvitee('tok-1', logger)).toBe('email_not_verified');
  });

  it('reports any other refusal as failed', async () => {
    respond(503, { error: { code: 'DB_UNAVAILABLE' } });
    expect(await activateInvitee('tok-1', logger)).toBe('failed');
  });

  it('reports a network failure as failed', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await activateInvitee('tok-1', logger)).toBe('failed');
  });
});
