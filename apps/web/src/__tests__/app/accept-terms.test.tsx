/**
 * `/accept-terms`: the server page (fresh status check, redirects, which
 * audience's documents) and the client view (posting the versions, 409, failure).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import messages from '@/i18n/messages/en.json';
import type { ConsentGateProps } from '@/components/consent/ConsentGate';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { redirect, refresh } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  refresh: vi.fn(),
}));
const { fetchTermsStatus } = vi.hoisted(() => ({ fetchTermsStatus: vi.fn() }));
const { getFreshAccessToken } = vi.hoisted(() => ({
  getFreshAccessToken: vi.fn(async (): Promise<string | null> => 'AT-FRESH'),
}));
const { storeTermsStatus } = vi.hoisted(() => ({ storeTermsStatus: vi.fn(async () => {}) }));
const { loadConsentContent } = vi.hoisted(() => ({ loadConsentContent: vi.fn() }));

vi.mock('@/lib/server-session', () => ({ getSession }));
vi.mock('next/navigation', () => ({ redirect, useRouter: () => ({ refresh }) }));
vi.mock('@/lib/terms-status.server', () => ({
  ACCEPT_TERMS_PATH: '/accept-terms',
  fetchTermsStatus,
}));
vi.mock('@/lib/upstream-client', () => ({ getFreshAccessToken }));
vi.mock('@/lib/terms-guard.server', () => ({ storeTermsStatus }));
vi.mock('@/app/(public)/register/register-server', () => ({ loadConsentContent }));
vi.mock('@/components/shell/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/shell/ThemeToggle', () => ({ ThemeToggle: () => null }));
// jsdom cannot scroll, so the gate is a stub that shows its documents and accepts.
vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: ({ open, docs, agreeLabel, onAccept, onCancel }: ConsentGateProps) =>
    open ? (
      <div data-testid="gate" data-cancellable={String(Boolean(onCancel))}>
        {docs.map((d) => (
          <h3 key={d.id}>{d.title}</h3>
        ))}
        <span>{agreeLabel}</span>
        <button type="button" onClick={onAccept}>
          accept
        </button>
      </div>
    ) : null,
}));

import AcceptTermsPage from '@/app/accept-terms/page';
import { AcceptTermsView } from '@/app/accept-terms/AcceptTermsView';

/** An unsigned JWT carrying `claims`; the page only decodes it. */
function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}
const COORDINATOR_TOKEN = jwt({ sub: 'c1', aggregator_id: 'agg-1' });
const OWNER_TOKEN = jwt({ sub: 'o1' });

const content = {
  aggregator: {
    terms: { version: 3, title: 'Coordinator Terms', content: 'ct' },
    privacy: { version: 2, title: 'Coordinator Privacy', content: 'cp' },
  },
  org: {
    terms: { version: 5, title: 'Org Terms', content: 'ot' },
    privacy: { version: 4, title: 'Org Privacy', content: 'op' },
  },
};

function withIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

async function runPage(returnTo?: string | string[]): Promise<ReactElement | string> {
  try {
    return (await AcceptTermsPage({
      searchParams: Promise.resolve(returnTo === undefined ? {} : { returnTo }),
    })) as ReactElement;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('AcceptTermsPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ sub: 'c1', accessToken: COORDINATOR_TOKEN });
    getFreshAccessToken.mockResolvedValue('AT-FRESH');
    loadConsentContent.mockResolvedValue(content);
  });

  it('sends a visitor without a session to log in', async () => {
    getSession.mockResolvedValue(null);
    expect(await runPage()).toBe('REDIRECT:/api/auth/login?returnTo=/accept-terms');
  });

  it('sends a session whose token cannot be refreshed to log in', async () => {
    getFreshAccessToken.mockResolvedValue(null);
    expect(await runPage()).toBe('REDIRECT:/api/auth/login?returnTo=/accept-terms');
  });

  it('stores ok and redirects to returnTo when the terms are accepted', async () => {
    fetchTermsStatus.mockResolvedValue({ status: 'ok' });
    expect(await runPage('/dashboard/links')).toBe('REDIRECT:/dashboard/links');
    expect(fetchTermsStatus).toHaveBeenCalledWith('AT-FRESH');
    expect(storeTermsStatus).toHaveBeenCalledWith('ok');
  });

  it('redirects to returnTo when the check fails, storing unknown so the guard fails open', async () => {
    fetchTermsStatus.mockResolvedValue({ status: 'unknown' });
    expect(await runPage('/dashboard')).toBe('REDIRECT:/dashboard');
    expect(storeTermsStatus).toHaveBeenCalledWith('unknown');
  });

  it.each([
    ['a coordinator', COORDINATOR_TOKEN, '/dashboard'],
    ['an owner', OWNER_TOKEN, '/console'],
  ])('falls back by token type for %s', async (_label, accessToken, fallback) => {
    getSession.mockResolvedValue({ sub: 'u', accessToken });
    fetchTermsStatus.mockResolvedValue({ status: 'ok' });
    expect(await runPage('https://evil.example')).toBe(`REDIRECT:${fallback}`);
    expect(await runPage('//evil.example')).toBe(`REDIRECT:${fallback}`);
    expect(await runPage()).toBe(`REDIRECT:${fallback}`);
  });

  it('never returns to the terms page itself (no loop)', async () => {
    fetchTermsStatus.mockResolvedValue({ status: 'ok' });
    expect(await runPage('/accept-terms?returnTo=%2Fdashboard')).toBe('REDIRECT:/dashboard');
  });

  it('renders the coordinator documents for a coordinator, with no way to close the gate', async () => {
    fetchTermsStatus.mockResolvedValue({
      status: 'outstanding',
      audience: 'aggregator',
      termsVersion: 3,
      privacyVersion: 2,
    });
    const page = await runPage('/dashboard');
    expect(typeof page).not.toBe('string');
    withIntl(page as ReactElement);
    expect(screen.getByText('Coordinator Terms')).toBeInTheDocument();
    expect(screen.getByText('Coordinator Privacy')).toBeInTheDocument();
    expect(screen.queryByText('Org Terms')).not.toBeInTheDocument();
    expect(screen.getByTestId('gate')).toHaveAttribute('data-cancellable', 'false');
    expect(screen.getByText(messages.accept_terms.agree_label)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: messages.accept_terms.log_out })).toHaveAttribute(
      'href',
      '/api/auth/logout',
    );
    expect(storeTermsStatus).toHaveBeenCalledWith('outstanding');
  });

  it('renders the org documents for an owner', async () => {
    getSession.mockResolvedValue({ sub: 'o1', accessToken: OWNER_TOKEN });
    fetchTermsStatus.mockResolvedValue({
      status: 'outstanding',
      audience: 'org',
      termsVersion: 5,
      privacyVersion: 4,
    });
    withIntl((await runPage('/console')) as ReactElement);
    expect(screen.getByText('Org Terms')).toBeInTheDocument();
    expect(screen.getByText('Org Privacy')).toBeInTheDocument();
    expect(screen.queryByText('Coordinator Terms')).not.toBeInTheDocument();
  });

  it('shows the load error, not an empty gate, when the documents cannot load', async () => {
    fetchTermsStatus.mockResolvedValue({
      status: 'outstanding',
      audience: 'aggregator',
      termsVersion: 3,
      privacyVersion: 2,
    });
    loadConsentContent.mockResolvedValue(null);
    withIntl((await runPage('/dashboard')) as ReactElement);
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.accept_terms.reload })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: messages.accept_terms.log_out })).toBeInTheDocument();
  });

  it('shows the load error when the documents on disk are not the versions to accept', async () => {
    fetchTermsStatus.mockResolvedValue({
      status: 'outstanding',
      audience: 'aggregator',
      termsVersion: 4,
      privacyVersion: 2,
    });
    withIntl((await runPage('/dashboard')) as ReactElement);
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();
    expect(screen.getByText(messages.register.consent.load_failed_detail)).toBeInTheDocument();
  });
});

describe('AcceptTermsView', () => {
  const fetchMock = vi.fn();
  const assign = vi.fn();
  const reload = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign, reload },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  const docs = [
    { id: 'privacy', cap: 'Privacy', title: 'P', body: 'p' },
    { id: 'terms', cap: 'Terms', title: 'T', body: 't' },
  ];
  const view = () =>
    withIntl(
      <AcceptTermsView docs={docs} termsVersion={3} privacyVersion={2} returnTo="/dashboard/x" />,
    );

  it('posts the versions and goes to returnTo on 200', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ recorded: 1 }), { status: 200 }));
    view();
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard/x'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/consent',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms_version: 3, privacy_version: 2 }),
      }),
    );
  });

  it('shows changed and refreshes on 409', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'CONSENT_VERSION_CHANGED' }), { status: 409 }),
    );
    view();
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    expect(await screen.findByText(messages.accept_terms.changed)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows failed and the log-out link, without the gate, on another error', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    view();
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    expect(await screen.findByText(messages.accept_terms.failed)).toBeInTheDocument();
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: messages.accept_terms.log_out })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.accept_terms.reload }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows failed when the request cannot be sent', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    view();
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    expect(await screen.findByText(messages.accept_terms.failed)).toBeInTheDocument();
  });
});
