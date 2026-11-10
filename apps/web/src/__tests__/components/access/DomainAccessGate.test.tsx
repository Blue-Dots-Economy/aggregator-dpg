import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { AuthProvider } from '@/lib/auth-context';

const { useActiveDomain } = vi.hoisted(() => ({ useActiveDomain: vi.fn() }));
vi.mock('@/hooks/useActiveDomain', () => ({ useActiveDomain }));

import { DomainAccessGate } from '@/components/access/DomainAccessGate';

const SEEKER = { id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' };

function state(overrides: Record<string, unknown> = {}) {
  return {
    domains: [SEEKER],
    active: 'seeker',
    setActive: vi.fn(),
    ready: true,
    error: false,
    retrying: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderGate() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AuthProvider initialUser={{ id: 'u1', name: 'C', org: '', email: 'c@example.com' }}>
        <DomainAccessGate>
          <p>page content</p>
        </DomainAccessGate>
      </AuthProvider>
    </NextIntlClientProvider>,
  );
}

describe('DomainAccessGate', () => {
  beforeEach(() => useActiveDomain.mockReset());

  it('renders the page for a coordinator with a profile type', () => {
    useActiveDomain.mockReturnValue(state());
    renderGate();
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('renders the loading text until the profile loads', () => {
    useActiveDomain.mockReturnValue(state({ ready: false, domains: [], active: undefined }));
    renderGate();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('renders the no-access notice with the account and a sign-out button', () => {
    useActiveDomain.mockReturnValue(state({ domains: [], active: undefined }));
    renderGate();
    expect(screen.getByRole('heading', { name: "You don't have access yet" })).toBeInTheDocument();
    expect(screen.getByText('c@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('page content')).not.toBeInTheDocument();
  });

  it('renders the load error with a retry when the profile failed to load', () => {
    const retry = vi.fn();
    useActiveDomain.mockReturnValue(state({ error: true, domains: [], active: undefined, retry }));
    renderGate();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load your account details");
    expect(screen.queryByText("You don't have access yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('disables the retry while it runs', () => {
    useActiveDomain.mockReturnValue(state({ error: true, retrying: true, domains: [] }));
    renderGate();
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
  });
});
