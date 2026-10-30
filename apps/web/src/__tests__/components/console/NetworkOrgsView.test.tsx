/**
 * `NetworkOrgsView`: the network summary with its organisation limit, the
 * status filters, and the organisations as a tree or a list with search.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { countOrgs } from '@/lib/org-filters';

type Row = OrgSearchResponse['orgs'][number];

const org = (id: string, name: string, over: Partial<Row> = {}): Row => ({
  id,
  slug: id,
  name,
  org_type: 'aggregator',
  status: 'active',
  is_default: false,
  url: null,
  locations: [],
  legal_name: null,
  gst_number: null,
  known_as: null,
  known_as_name: null,
  depth: 1,
  parent_id: 'root',
  parent_name: 'Blue Dots',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 3,
  child_count: 0,
  pending_count: 0,
  ...over,
});

const orgs = [
  org('a', 'Edge Org A', { coordinator_count: 54, pending_count: 8, child_count: 1 }),
  org('b', 'Edge Org B', { parent_id: 'a', parent_name: 'Edge Org A', depth: 2 }),
  org('c', 'Cotton Co', { status: 'pending', known_as_name: 'Cluster' }),
  org('d', 'Dropped Org', { status: 'inactive' }),
];

function renderView(props: Partial<Parameters<typeof NetworkOrgsView>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NetworkOrgsView
        rootName="Blue Dots"
        orgs={orgs}
        more={false}
        totalOrgs={4}
        maxOrgs={50}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

const filter = (name: RegExp) => screen.getByRole('button', { name });
const orgLinks = () =>
  screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/console/orgs/'));

describe('countOrgs', () => {
  it('counts every organisation and each status', () => {
    expect(countOrgs(orgs)).toEqual({ all: 4, active: 2, pending: 1, inactive: 1 });
  });
});

describe('NetworkOrgsView', () => {
  it('shows the network with its organisation limit', () => {
    renderView();
    expect(screen.getAllByText('Blue Dots').length).toBeGreaterThan(0);
    const bar = screen.getByRole('progressbar', { name: messages.console.orgs.capacity });
    expect(bar).toHaveAttribute('aria-valuenow', '4');
    expect(bar).toHaveAttribute('aria-valuemax', '50');
  });

  it('starts as a tree under the network, with each organisation opening its page', () => {
    renderView();
    expect(screen.getByText(messages.console.orgs.network_tag)).toBeInTheDocument();
    expect(orgLinks().map((a) => a.getAttribute('href'))).toEqual([
      '/console/orgs/c',
      '/console/orgs/d',
      '/console/orgs/a',
      '/console/orgs/b',
    ]);
    expect(screen.getByRole('link', { name: /Edge Org A/ })).toHaveTextContent('8 pending');
  });

  it('filters by status from the summary and clears the filter from its chip', () => {
    renderView();
    fireEvent.click(filter(/Pending review\s*1/));
    expect(orgLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.clear_filter }));
    expect(orgLinks()).toHaveLength(4);
  });

  it('searches names and "known as" in the list', () => {
    renderView({ initialView: 'list' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search organisations' }), {
      target: { value: 'cluster' },
    });
    expect(orgLinks()).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Cotton Co/ })).toHaveTextContent('Under Blue Dots');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });
    expect(screen.getByText(messages.console.orgs.empty)).toBeInTheDocument();
  });

  it('says when nothing is waiting for review', () => {
    renderView({ initialFilter: 'pending', orgs: orgs.filter((o) => o.status !== 'pending') });
    expect(screen.getByText(messages.console.orgs.empty_pending)).toBeInTheDocument();
  });

  it('switches between tree and list', () => {
    renderView();
    const view = screen.getByRole('group', { name: 'Show as' });
    fireEvent.click(within(view).getByRole('button', { name: /List/ }));
    expect(screen.queryByText(messages.console.orgs.network_tag)).toBeNull();
    fireEvent.click(within(view).getByRole('button', { name: /Tree/ }));
    expect(screen.getByText(messages.console.orgs.network_tag)).toBeInTheDocument();
  });
});
