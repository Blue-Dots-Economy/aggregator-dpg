/**
 * Server-component test: `(public)/register/owner/page.tsx` (#619).
 *
 * Invokes the async page function directly. Covers the deep-link gating chain:
 * session → redirect; org schema missing →
 * notFound; and the happy path rendering OwnerRegisterView with the org schema
 * + org consent content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
const { loadOrgSchema, loadConsentContent, readInvite } = vi.hoisted(() => ({
  loadOrgSchema: vi.fn(),
  loadConsentContent: vi.fn(),
  readInvite: vi.fn(),
}));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('@/app/(public)/register/register-server', () => ({
  loadOrgSchema,
  loadConsentContent,
}));
vi.mock('@/lib/invite-read.server', () => ({ readInvite }));

import OwnerRegisterPage from '@/app/(public)/register/owner/page';

const orgSchema = { title: 'Organisation Registration', properties: {} };

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null);
  redirect.mockClear();
  notFound.mockClear();
  loadOrgSchema.mockReset().mockResolvedValue({ schema: orgSchema, uiSchema: {} });
  readInvite.mockReset().mockResolvedValue({
    ok: true,
    invite: { email: 'ravi@enable.org', expires_at: 'x', org: { id: 'p1', name: 'Parent Org' } },
  });
  loadConsentContent.mockReset().mockResolvedValue({
    aggregator: { terms: {}, privacy: {} },
    org: { terms: { version: 1, title: 'T', content: 'T' }, privacy: {} },
  });
});

/** Runs the page and returns the thrown error's message (or null if none). */
async function runAndCatch(search: { invite?: string } = {}): Promise<string | null> {
  try {
    await OwnerRegisterPage({ searchParams: Promise.resolve(search) });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('OwnerRegisterPage (server component)', () => {
  it('redirects to /dashboard when a session already exists', async () => {
    getSession.mockResolvedValue({ sub: 'u1' });
    expect(await runAndCatch()).toBe('REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('404s when the org schema is missing', async () => {
    loadOrgSchema.mockResolvedValue(null);
    expect(await runAndCatch({ invite: 'tok' })).toBe('NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('says onboarding is by invitation only without an invite, reading nothing', async () => {
    const el = await OwnerRegisterPage({ searchParams: Promise.resolve({}) });
    expect(el.props).toEqual({ reason: 'invite_only' });
    expect(readInvite).not.toHaveBeenCalled();
    expect(loadOrgSchema).not.toHaveBeenCalled();
  });

  it('renders OwnerRegisterView with the org schema + org consent on the happy path', async () => {
    const el = await OwnerRegisterPage({ searchParams: Promise.resolve({ invite: 'tok' }) });
    expect(el.props.schema).toBe(orgSchema);
    expect(el.props.uiSchema).toEqual({});
    expect(el.props.orgConsentContent).toEqual({
      terms: { version: 1, title: 'T', content: 'T' },
      privacy: {},
    });
    expect(redirect).not.toHaveBeenCalled();
    expect(notFound).not.toHaveBeenCalled();
  });

  it('passes the read org invite to the form', async () => {
    readInvite.mockResolvedValue({
      ok: true,
      invite: { email: 'ravi@enable.org', expires_at: 'x', org: { id: 'p1', name: 'Parent Org' } },
    });
    const el = await OwnerRegisterPage({ searchParams: Promise.resolve({ invite: 'tok' }) });
    expect(readInvite).toHaveBeenCalledWith('org', 'tok');
    expect(el.props.invite).toEqual({
      token: 'tok',
      email: 'ravi@enable.org',
      parentName: 'Parent Org',
    });
  });

  it('shows why an unusable org invite cannot be used', async () => {
    readInvite.mockResolvedValue({ ok: false, reason: 'expired' });
    const el = await OwnerRegisterPage({ searchParams: Promise.resolve({ invite: 'tok' }) });
    expect(el.props).toEqual({ reason: 'expired' });
  });
});
