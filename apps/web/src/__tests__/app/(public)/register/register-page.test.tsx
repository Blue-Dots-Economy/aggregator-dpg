/**
 * Server-component test: `(public)/register/page.tsx`. Onboarding is by
 * invitation only, so the page says so; a signed-in user goes to the dashboard.
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

import RegisterPage from '@/app/(public)/register/page';

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
});

describe('RegisterPage (server component)', () => {
  it('redirects to /dashboard when a session exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    await expect(RegisterPage()).rejects.toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('says onboarding is by invitation only', async () => {
    const el = await RegisterPage();
    expect(el.props).toEqual({ reason: 'invite_only' });
  });
});
