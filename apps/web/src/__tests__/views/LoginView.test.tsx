/**
 * View test: <LoginView /> — public sign-in / register landing page.
 *
 * Covers the two-card welcome surface, the sign-in/register navigation
 * (asserted via `window.location.href`), and each error-banner branch
 * (`session_expired`, `org_no_portal`, known OIDC error codes, and an
 * unrecognised code falling back to the generic message).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test Aggregator' } };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { LoginView } from '@/app/(public)/login/LoginView';

function renderView(props: { returnTo?: string; error?: string | null } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LoginView returnTo={props.returnTo ?? '/dashboard'} error={props.error ?? null} />
    </NextIntlClientProvider>,
  );
}

describe('<LoginView />', () => {
  let originalHref: Location;

  beforeEach(() => {
    originalHref = window.location;
    // jsdom's window.location.href setter doesn't navigate; replace with a
    // configurable stub so we can assert on the assigned value.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalHref, href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalHref });
    vi.clearAllMocks();
  });

  it('renders the welcome heading and both cards with no error banner', () => {
    renderView();
    expect(screen.getByText(messages.auth.welcome_heading)).toBeInTheDocument();
    expect(screen.getByText(messages.auth.existing_title)).toBeInTheDocument();
    expect(screen.getByText(messages.auth.register_title)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells the reader what continuing commits them to, and links both documents', () => {
    // The page had no legal line at all, though signing in from it IS the act
    // of agreeing — the sibling Signals login has always carried one.
    renderView();
    expect(screen.getByText(/By continuing you agree to the/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/legal#privacy',
    );
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal#terms');
  });

  it('navigates to the BFF login route with the returnTo param on sign-in click', () => {
    renderView({ returnTo: '/dashboard/onboarding' });
    screen.getByText(messages.auth.existing_title).closest('button')!.click();
    expect(window.location.href).toBe(
      `/api/auth/login?returnTo=${encodeURIComponent('/dashboard/onboarding')}`,
    );
  });

  it('navigates to /register on the "Become a member" click', () => {
    renderView();
    screen.getByText(messages.auth.register_title).closest('button')!.click();
    expect(window.location.href).toBe('/register');
  });

  it('renders the session_expired banner', () => {
    renderView({ error: 'session_expired' });
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.session_expired);
  });

  it('renders the org_no_portal banner', () => {
    renderView({ error: 'org_no_portal' });
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.org_no_portal);
  });

  it('renders a humanised message for a known OIDC error code', () => {
    renderView({ error: 'oidc_error_access_denied' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      messages.auth.errors.oidc_error_access_denied,
    );
  });

  it('falls back to the generic unknown-error message for an unrecognised code', () => {
    renderView({ error: 'some_totally_unknown_code' });
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.errors.unknown);
  });
});
