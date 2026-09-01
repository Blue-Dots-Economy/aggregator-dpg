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

  it('renders the sign-in card with no error banner and no register entry (#619)', () => {
    renderView();
    expect(screen.getByText(messages.auth.welcome_heading)).toBeInTheDocument();
    expect(screen.getByText(messages.auth.existing_title)).toBeInTheDocument();
    // Registration is not linked from the login homepage anymore (#619).
    expect(screen.queryByText(messages.auth.register_title)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Invite-only recovery line (#701) points a mis-linked coordinator at their org.
    expect(screen.getByText(/contact your organisation administrator/i)).toBeInTheDocument();
  });

  it('navigates to the BFF login route with the returnTo param on sign-in click', () => {
    renderView({ returnTo: '/dashboard/onboarding' });
    screen.getByText(messages.auth.existing_title).closest('button')!.click();
    expect(window.location.href).toBe(
      `/api/auth/login?returnTo=${encodeURIComponent('/dashboard/onboarding')}`,
    );
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
