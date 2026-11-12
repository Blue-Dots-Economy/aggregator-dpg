/**
 * Unit tests for the console sidebar: the links each actor gets, which link is
 * active, and the account card, in the shell shared with the coordinator
 * portal. Hooks the shared shell reads are mocked, as in `Sidebar.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';

const { useAuth, useThemeMode, useAggregatorConfig, usePathname } = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useThemeMode: vi.fn(),
  useAggregatorConfig: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('@/lib/auth-context', () => ({ useAuth, useCan: () => () => true }));
vi.mock('@/lib/theme-mode', () => ({ useThemeMode }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG: {
    aggregator: { name: 'Aggregator' },
    brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Portal', url_slug: 'dashboard' },
    network: { id: 'blue_dot' },
    domains: [],
  },
}));
vi.mock('@/hooks/useDashboard', () => ({ useDashboard: () => ({ data: undefined }) }));
vi.mock('@/hooks/useProfile', () => ({ useProfileRaw: () => ({ data: undefined }) }));
vi.mock('next/navigation', () => ({ usePathname }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { ConsoleSidebar } from '@/components/console/ConsoleSidebar';

const account = { title: 'Asha Rao', subtitle: 'nav.network_admin' };

/** The desktop sidebar (the mobile drawer is closed). */
const aside = () => screen.getByRole('complementary');

beforeEach(() => {
  vi.clearAllMocks();
  usePathname.mockReturnValue('/console');
  useAuth.mockReturnValue({ signOut: vi.fn(), supportEnabled: false });
  useThemeMode.mockReturnValue({ mode: 'light' });
  useAggregatorConfig.mockReturnValue({ data: undefined });
});

describe('<ConsoleSidebar />', () => {
  const links = () =>
    within(aside())
      .getAllByRole('link')
      .map((a) => [a.textContent, a.getAttribute('href')]);

  it('gives an owner Dashboard, My Team under My Blue Dots, Onboarded Organisations and Profile', () => {
    render(<ConsoleSidebar teamHref="/console" showProfile account={account} />);
    expect(links()).toEqual([
      ['nav.dashboard', '/console/dashboard'],
      ['nav.my_team', '/console'],
      ['nav.organisations', '/console/orgs'],
      ['nav.profile', '/console/profile'],
    ]);
    expect(within(aside()).getByText('nav.my_blue_dots')).toBeInTheDocument();
    expect(within(aside()).getByText('Blue Dots')).toBeInTheDocument();
    expect(within(aside()).getByText('nav.portal_label')).toBeInTheDocument();
  });

  it('gives the network admin no My Team and no Profile, and never roles and permissions', () => {
    render(<ConsoleSidebar teamHref={null} showProfile={false} account={account} />);
    expect(links()).toEqual([
      ['nav.dashboard', '/console/dashboard'],
      ['nav.organisations', '/console/orgs'],
    ]);
    expect(within(aside()).queryByText('nav.my_blue_dots')).toBeNull();
    expect(within(aside()).queryByText('nav.access')).toBeNull();
  });

  it('marks My Team active only on /console itself when it is the home page', () => {
    usePathname.mockReturnValue('/console/orgs');
    render(<ConsoleSidebar teamHref="/console" showProfile account={account} />);
    const team = within(aside()).getByRole('link', { name: 'nav.my_team' });
    const orgs = within(aside()).getByRole('link', { name: 'nav.organisations' });
    expect(team.className).not.toContain('nav-active');
    expect(orgs.className).toContain('nav-active');
  });

  it('shows the account card with the role, and sign-out, but no contact support', () => {
    render(<ConsoleSidebar teamHref={null} showProfile={false} account={account} />);
    expect(within(aside()).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(aside()).getByText('AR')).toBeInTheDocument();
    expect(within(aside()).getByText('nav.network_admin')).toBeInTheDocument();
    expect(within(aside()).getByRole('button', { name: 'sign_out' })).toBeInTheDocument();
    expect(within(aside()).queryByText('contact_support')).toBeNull();
  });

  it('has no account-details pop-up, and the card is plain text, without `details`', () => {
    render(<ConsoleSidebar teamHref={null} showProfile={false} account={account} />);
    expect(within(aside()).queryByRole('button', { name: /Asha Rao/ })).toBeNull();
  });

  it('opens the account-details pop-up on click, independently of sign-out, and replaces the old My account page', () => {
    const signOut = vi.fn();
    useAuth.mockReturnValue({ signOut, supportEnabled: false });
    const withDetails = {
      ...account,
      details: [{ label: 'Email', value: 'asha@example.org' }],
    };
    render(<ConsoleSidebar teamHref={null} showProfile={false} account={withDetails} />);
    const toggle = within(aside()).getByRole('button', { name: /Asha Rao/ });

    expect(screen.queryByText('asha@example.org')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('asha@example.org')).toBeInTheDocument();

    fireEvent.click(within(aside()).getByRole('button', { name: 'sign_out' }));
    expect(signOut).toHaveBeenCalledOnce();
    expect(screen.getByText('asha@example.org')).toBeInTheDocument(); // sign-out didn't close it

    fireEvent.click(toggle);
    expect(screen.queryByText('asha@example.org')).toBeNull();
  });

  it('never offers Invite from the sidebar: it lives on the team and organisation pages', () => {
    render(<ConsoleSidebar teamHref="/console/coordinators" showProfile account={account} />);
    const hrefs = within(aside())
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/console/coordinators');
    expect(hrefs).not.toContain('/console/invite');
    expect(hrefs).not.toContain('/console/orgs/invite');
  });
});
