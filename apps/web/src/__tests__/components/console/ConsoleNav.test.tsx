/**
 * Unit tests for ConsoleNav.
 *
 * Covers: the network-admin-only Organisations link, the common links and
 * sign-out, and the active-link highlighting (exact match for /console,
 * prefix match for the sub-sections).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { ConsoleNav } from '@/components/console/ConsoleNav';

let pathname = '/console';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

function renderNav(isNetworkAdmin: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConsoleNav isNetworkAdmin={isNetworkAdmin} />
    </NextIntlClientProvider>,
  );
}

describe('<ConsoleNav />', () => {
  beforeEach(() => {
    pathname = '/console';
  });

  it('shows the Organisations link only for the network admin', () => {
    renderNav(true);
    expect(
      screen.getByRole('link', { name: messages.console.nav.organisations }),
    ).toBeInTheDocument();
  });

  it('hides the Organisations link for a plain org owner', () => {
    renderNav(false);
    expect(screen.queryByRole('link', { name: messages.console.nav.organisations })).toBeNull();
    expect(screen.getByRole('link', { name: messages.console.nav.coordinators })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: messages.console.nav.sign_out })).toHaveAttribute(
      'href',
      '/api/auth/logout',
    );
  });

  it('marks Home active by exact match on /console', () => {
    pathname = '/console';
    renderNav(true);
    expect(screen.getByRole('link', { name: messages.console.nav.home })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: messages.console.nav.coordinators }),
    ).not.toHaveAttribute('aria-current');
  });

  it('marks a sub-section active by prefix match', () => {
    pathname = '/console/coordinators/abc';
    renderNav(true);
    expect(
      screen.getByRole('link', { name: messages.console.nav.coordinators }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: messages.console.nav.home })).not.toHaveAttribute(
      'aria-current',
    );
  });
});
