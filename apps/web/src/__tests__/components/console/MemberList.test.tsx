/**
 * `MemberList`: the three count tiles, the status switch and the search over
 * one table holding the joined rows and the invited ones.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import hiMessages from '@/i18n/messages/hi.json';
import { fillTerms } from '@/i18n/terms';
import { MemberList, type MemberRow } from '@/components/console/MemberList';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

const rows: MemberRow[] = [
  {
    id: 'u1',
    name: 'Test User 1',
    detail: 'testuser1@yopmail.com',
    status: 'active',
    href: '/console/coordinators/u1',
    cells: ['Seekers'],
  },
  {
    id: 'u4',
    name: 'Test User 4',
    detail: 'testuser4@yopmail.com',
    status: 'pending',
    href: '/console/coordinators/u4',
    cells: ['Providers'],
  },
  {
    id: 'invite:testuser6@yopmail.com',
    name: 'testuser6@yopmail.com',
    detail: 'Invite sent 13 Nov 2026',
    status: 'pending',
    href: null,
    cells: ['—'],
  },
];

function renderList(over: Partial<Parameters<typeof MemberList>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MemberList
        kind="users"
        rows={rows}
        counts={{ all: '3', active: '1', pending: '2' }}
        columns={['Domains']}
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

const tile = (label: RegExp) => screen.getByRole('button', { name: label });
const tableRows = () => screen.getAllByRole('row').slice(1);
const switchGroup = () => screen.getByRole('group', { name: `Show ${term('users')}` });

describe('MemberList', () => {
  it('shows three tiles and lists joined and invited rows together', () => {
    renderList();
    expect(tile(new RegExp(`^${term('Users')}\\s*3\\s*Invited by you`))).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(tile(/^Active\s*1\s*Can sign in/)).toBeInTheDocument();
    expect(tile(/^Invited\s*2\s*Yet to verify with a code/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rejected/ })).toBeNull();
    expect(tableRows()).toHaveLength(3);
  });

  it('offers All, Active and Invited, and filters from a tile or the switch', () => {
    renderList();
    const names = within(switchGroup())
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual(['All', 'Active', 'Invited']);

    fireEvent.click(tile(/^Invited\s*2/));
    expect(tableRows()).toHaveLength(2);
    expect(within(switchGroup()).getByRole('button', { name: 'Invited' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(within(switchGroup()).getByRole('button', { name: 'Active' }));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('Test User 1')).toBeInTheDocument();
  });

  it('opens on the filter it is given', () => {
    renderList({ initialFilter: 'pending' });
    expect(tableRows()).toHaveLength(2);
  });

  it('links joined rows and leaves an unused invite without a link', () => {
    renderList();
    expect(screen.getByRole('link', { name: 'View Test User 1' })).toHaveAttribute(
      'href',
      '/console/coordinators/u1',
    );
    expect(screen.queryByRole('link', { name: /testuser6/ })).toBeNull();
    expect(screen.getByText('Invite sent 13 Nov 2026')).toBeInTheDocument();
  });

  it('searches the name and the line under it, ignoring case', () => {
    renderList();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or email' }), {
      target: { value: 'TESTUSER6' },
    });
    expect(tableRows()).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nobody' } });
    expect(screen.getByText(`No ${term('users')} match.`)).toBeInTheDocument();
  });

  it('says when nobody is waiting on an invite', () => {
    renderList({ rows: rows.slice(0, 1), counts: { all: '1', active: '1', pending: '0' } });
    expect(tile(/^Invited\s*0\s*Everyone has verified/)).toBeInTheDocument();
  });

  it('shows the extra columns and the footer', () => {
    renderList({ footer: 'Showing the newest 3.' });
    expect(screen.getByRole('columnheader', { name: 'Domains' })).toBeInTheDocument();
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.getByText('Showing the newest 3.')).toBeInTheDocument();
  });

  it('uses the organisation copy for an organisation list', () => {
    renderList({ kind: 'orgs', columns: ['Joined'] });
    expect(screen.getByRole('searchbox', { name: `Search ${term('orgs')}` })).toBeInTheDocument();
    expect(tile(new RegExp(`^${term('Orgs')}\\s*3`))).toBeInTheDocument();
  });

  it('renders in Hindi when the Hindi catalogue is active', () => {
    render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <MemberList
          kind="users"
          rows={rows}
          counts={{ all: '3', active: '1', pending: '2' }}
          columns={[]}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('searchbox', { name: 'नाम या ईमेल खोजें' })).toBeInTheDocument();
  });
});
