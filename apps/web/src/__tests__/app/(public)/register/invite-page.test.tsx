/**
 * Server-component test: `(public)/register/invite/page.tsx`, the owner grant
 * link older approval emails carried. It now asks the owner to sign in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
}));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect }));

import OwnerGrantLinkPage from '@/app/(public)/register/invite/page';

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
});

describe('OwnerGrantLinkPage (server component)', () => {
  it('sends a signed-in owner to the console', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    await expect(OwnerGrantLinkPage()).rejects.toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/console');
  });

  it('says the link no longer works and offers sign-in', async () => {
    const el = await OwnerGrantLinkPage();
    expect(el.props).toEqual({ reason: 'grant_retired' });
  });
});
