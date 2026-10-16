/**
 * Server Component test: `(console)/console/layout.tsx` — actor routing
 * (user & org Phase 5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionData } from '@/lib/session';
import type { MeResponse } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/server-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/components/console/ConsoleNav', () => ({
  ConsoleNav: () => <nav data-testid="console-nav" />,
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === 'x-pathname' ? '/console' : null),
  })),
}));

import ConsoleLayout from '@/app/(console)/console/layout';
import { getSession } from '@/lib/server-session';
import { getConsoleActor } from '@/lib/console-actor';
import { redirect } from 'next/navigation';

const session = {
  sub: 's',
  accessToken: 't',
  refreshToken: 'r',
  idToken: 'i',
  accessTokenExp: Date.now() + 1e6,
  refreshTokenExp: Date.now() + 1e6,
  createdAt: 0,
  lastSeenAt: 0,
} as SessionData;

const me = (over: Partial<MeResponse>): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  ...over,
});

describe('<ConsoleLayout />', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the console for an admin', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({}) });
    const el = await ConsoleLayout({ children: <p>child</p> });
    expect(el).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('sends a coordinator to the portal', async () => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ kind: 'coordinator' }) });
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it.each([
    ['not_provisioned', 'console_not_provisioned'],
    ['no_org', 'console_no_org'],
  ] as const)('signs out an admin the API refuses (%s)', async (reason, code) => {
    vi.mocked(getSession).mockResolvedValue(session);
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: false, reason });
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith(`/api/auth/logout?reason=${code}`);
  });

  it('sends a visitor without a session to login', async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(ConsoleLayout({ children: null })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Fconsole');
  });
});
