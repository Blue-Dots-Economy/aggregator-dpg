/**
 * `OrgCoordinators`: the count tiles, the status switch and the search on the
 * owner's organisation home, and the note shown when only part of the list
 * was loaded. The rows are the coordinators who have joined; those waiting to
 * verify are counted on their tile and listed elsewhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import hiMessages from '@/i18n/messages/hi.json';
import { fillTerms } from '@/i18n/terms';
import { OrgCoordinators, type OrgCoordinatorRow } from '@/components/console/OrgCoordinators';
import { WAITING_TO_VERIFY_ID } from '@/lib/waiting-to-verify';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

const rows: OrgCoordinatorRow[] = [
  {
    id: 'u1',
    name: 'Coord One',
    email: 'c1@edge.test',
    organisation: 'Edge Org A',
    status: 'active',
    domains: [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ],
  },
  {
    id: 'u3',
    name: 'rejected@edge.test',
    email: null,
    organisation: 'Edge Org A',
    status: 'inactive',
    domains: [{ id: 'seeker', label: 'Seekers' }],
  },
];

function renderList(over: Partial<Parameters<typeof OrgCoordinators>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgCoordinators
        rows={rows}
        total={3}
        pending={1}
        complete
        allHref="/console/coordinators?org_id=org-1"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

const tile = (label: RegExp) => screen.getByRole('button', { name: label });
const tableRows = () => screen.getAllByRole('row').slice(1);

describe('OrgCoordinators', () => {
  it('counts joined users, each status and those waiting to verify, listing the joined ones', () => {
    renderList();
    expect(tile(new RegExp(`^${term('Users')}\\s*2`))).toHaveAttribute('aria-pressed', 'true');
    expect(tile(/^Active\s*1\s*Can sign in/)).toBeInTheDocument();
    expect(tile(/^Waiting to verify\s*1\s*Yet to verify with a code/)).toBeInTheDocument();
    expect(tile(/^Rejected\s*1\s*Not approved/)).toBeInTheDocument();
    expect(tableRows()).toHaveLength(2);
    expect(tile(new RegExp(`^${term('Users')}`))).toHaveTextContent('Showing below');
  });

  it('filters the list from a tile and from the status switch, which has no waiting option', () => {
    renderList();
    fireEvent.click(tile(/^Rejected\s*1/));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('rejected@edge.test')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: `Show ${term('users')}` });
    expect(within(group).queryByRole('button', { name: /Pending|Waiting/ })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Active' }));
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('Coord One')).toBeInTheDocument();
    expect(tile(/^Active\s*1/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('scrolls to the waiting list from its tile instead of filtering', () => {
    const target = document.createElement('div');
    target.id = WAITING_TO_VERIFY_ID;
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    renderList();

    fireEvent.click(tile(/^Waiting to verify/));

    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(tableRows()).toHaveLength(2);
    expect(tile(/^Waiting to verify/)).toHaveAttribute('aria-pressed', 'false');
    target.remove();
  });

  it('searches by name or email, ignoring case', () => {
    renderList();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or email' }), {
      target: { value: 'C1@EDGE' },
    });
    expect(tableRows()).toHaveLength(1);
    expect(screen.getByText('Coord One')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nobody' } });
    expect(screen.getByText(`No ${term('users')} match.`)).toBeInTheDocument();
  });

  it('links each name and a view icon', () => {
    renderList();
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View Coord One' })).toHaveAttribute(
      'href',
      '/console/coordinators/u1',
    );
    expect(screen.getByRole('link', { name: 'Coord One' })).toHaveAttribute(
      'href',
      '/console/coordinators/u1',
    );
  });

  it('shows each served domain as a chip', () => {
    renderList();
    expect(screen.getAllByText('Seekers')).toHaveLength(2);
    expect(screen.getAllByText('Providers')).toHaveLength(1);
  });

  it('says when nobody is waiting to verify', () => {
    renderList({ total: 2, pending: 0 });
    expect(tile(/^Waiting to verify\s*0\s*Everyone has verified/)).toBeInTheDocument();
  });

  it('marks counted tiles and links the full list when only part was loaded', () => {
    renderList({ total: 250, pending: 4, complete: false });
    expect(tile(new RegExp(`^${term('Users')}\\s*246`))).toBeInTheDocument();
    expect(tile(/^Waiting to verify\s*4/)).toBeInTheDocument();
    expect(tile(/^Active\s*1\+/)).toBeInTheDocument();
    expect(screen.getByText(/Showing the newest 2\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `See all ${term('users')}` })).toHaveAttribute(
      'href',
      '/console/coordinators?org_id=org-1',
    );
  });

  it('renders in Hindi when the Hindi catalogue is active', () => {
    render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <OrgCoordinators rows={rows} total={3} pending={1} complete allHref="/x" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('searchbox', { name: 'नाम या ईमेल खोजें' })).toBeInTheDocument();
  });
});
