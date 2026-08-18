/**
 * Server Component test: `(protected)/layout.tsx`.
 *
 * `ProtectedLayout` is an `async function` Server Component — it is invoked
 * directly (not through RTL's `render`) so its body executes exactly like the
 * real Next.js runtime would, and the resolved JSX tree is then handed to
 * `render()`. `getSession`, `tokenAggregatorId`, and `callApi` (which backs
 * the private `fetchSupportEnabled`) are mocked as black boxes; `Sidebar` is
 * stubbed since its own rendering is out of scope here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import type { SessionData } from '@/lib/session';

vi.mock('@/lib/server-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/jwt', () => ({ tokenAggregatorId: vi.fn() }));
vi.mock('@/lib/upstream-client', () => ({ callApi: vi.fn() }));
vi.mock('@/components/shell/Sidebar', () => ({
  Sidebar: () => <nav data-testid="sidebar" />,
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    // Mirrors Next.js's real behaviour: `redirect()` throws to unwind the
    // render — callers assert on the thrown message.
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === 'x-pathname' ? '/dashboard' : null),
  })),
}));

import ProtectedLayout from '@/app/(protected)/layout';
import { getSession } from '@/lib/server-session';
import { tokenAggregatorId } from '@/lib/jwt';
import { callApi } from '@/lib/upstream-client';
import { redirect } from 'next/navigation';

function AuthProbe() {
  const { user, supportEnabled, isAuthenticated } = useAuth();
  return (
    <div>
      <span data-testid="user-name">{user?.name}</span>
      <span data-testid="user-org">{user?.org}</span>
      <span data-testid="support-enabled">{String(supportEnabled)}</span>
      <span data-testid="is-authenticated">{String(isAuthenticated)}</span>
    </div>
  );
}

function baseSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sub: 'user-1',
    email: 'coord@example.com',
    accessToken: 'tok',
    refreshToken: 'refresh-tok',
    idToken: 'id-tok',
    accessTokenExp: Date.now() + 1_000_000,
    refreshTokenExp: Date.now() + 1_000_000,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    ...overrides,
  } as SessionData;
}

async function renderLayout(children: ReactNode = <AuthProbe />) {
  const element = await ProtectedLayout({ children });
  return render(element);
}

describe('<ProtectedLayout />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children through AuthProvider with the session user + supportEnabled=true', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession({ name: 'Coord One' }));
    vi.mocked(tokenAggregatorId).mockReturnValue('agg-1');
    vi.mocked(callApi).mockResolvedValue(
      new Response(JSON.stringify({ enabled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as never,
    );

    await renderLayout();

    expect(screen.getByTestId('user-name')).toHaveTextContent('Coord One');
    expect(screen.getByTestId('user-org')).toHaveTextContent('coord@example.com');
    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('support-enabled')).toHaveTextContent('true');
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('falls back the display name to email, then phone, then sub when name is absent', async () => {
    vi.mocked(getSession).mockResolvedValue(
      baseSession({ name: undefined, email: undefined, phone: '9990001111', sub: 'user-9' }),
    );
    vi.mocked(tokenAggregatorId).mockReturnValue('agg-1');
    vi.mocked(callApi).mockResolvedValue(new Response('{}', { status: 200 }) as never);

    await renderLayout();

    expect(screen.getByTestId('user-name')).toHaveTextContent('9990001111');
  });

  // `redirect()` unwinds the render by throwing (mirroring Next.js's real
  // behaviour) — assert on the rejection + the exact target passed to the
  // mock rather than the stringified message (`.rejects.toThrow(<string>)`
  // mis-parses a URL containing `%2F`/`&` in this Vitest version).
  it('redirects to logout with org_no_portal when the token carries no aggregator_id', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession());
    vi.mocked(tokenAggregatorId).mockReturnValue(null);

    await expect(ProtectedLayout({ children: <div /> })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/api/auth/logout?reason=org_no_portal');
    // Support/config is never consulted once the portal-access gate rejects.
    expect(callApi).not.toHaveBeenCalled();
  });

  it('redirects to login with returnTo when there is no session', async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    await expect(ProtectedLayout({ children: <div /> })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/api/auth/login?returnTo=%2Fdashboard');
    expect(tokenAggregatorId).not.toHaveBeenCalled();
  });

  it('redirects to logout with reason=expired when the refresh token has already expired', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession({ refreshTokenExp: Date.now() - 1000 }));

    await expect(ProtectedLayout({ children: <div /> })).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/api/auth/logout?reason=expired&return=%2Fdashboard');
    expect(tokenAggregatorId).not.toHaveBeenCalled();
  });

  it('fails safe to supportEnabled=false when the support-config call throws', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession());
    vi.mocked(tokenAggregatorId).mockReturnValue('agg-1');
    vi.mocked(callApi).mockRejectedValue(new Error('upstream unreachable'));

    await renderLayout();

    expect(screen.getByTestId('support-enabled')).toHaveTextContent('false');
  });

  it('fails safe to supportEnabled=false when the support-config response is not ok', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession());
    vi.mocked(tokenAggregatorId).mockReturnValue('agg-1');
    vi.mocked(callApi).mockResolvedValue(new Response('{}', { status: 503 }) as never);

    await renderLayout();

    expect(screen.getByTestId('support-enabled')).toHaveTextContent('false');
  });

  it('treats a non-boolean/absent `enabled` field as false', async () => {
    vi.mocked(getSession).mockResolvedValue(baseSession());
    vi.mocked(tokenAggregatorId).mockReturnValue('agg-1');
    vi.mocked(callApi).mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as never,
    );

    await renderLayout();

    expect(screen.getByTestId('support-enabled')).toHaveTextContent('false');
  });
});
