/**
 * `NetworkOrgsView` and `OrgStatusTiles`: the network admin's organisation
 * tiles, the tree and list views, search and the status filter.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { NetworkOrgsView } from '@/components/console/NetworkOrgsView';
import { OrgStatusTiles } from '@/components/console/OrgStatusTiles';
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
  parent_name: 'Network',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 3,
  child_count: 0,
  pending_count: 0,
  ...over,
});

const orgs = [
  org('a', 'Edge Org A', { coordinator_count: 54, pending_count: 10, child_count: 1 }),
  org('b', 'Edge Org B', { parent_id: 'a', parent_name: 'Edge Org A', depth: 2 }),
  org('c', 'Cotton Co', { status: 'pending', known_as_name: 'Cluster' }),
  org('d', 'Dropped Org', { status: 'inactive' }),
];

function renderView(props: Partial<Parameters<typeof NetworkOrgsView>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NetworkOrgsView rootId="root" rootName="Blue Dots" orgs={orgs} more={false} {...props} />
    </NextIntlClientProvider>,
  );
}

const tile = (name: RegExp) => screen.getByRole('button', { name });
const rows = () => screen.getAllByRole('row').slice(1);

describe('countOrgs', () => {
  it('counts every organisation and each status', () => {
    expect(countOrgs(orgs)).toEqual({ all: 4, active: 2, pending: 1, inactive: 1 });
  });
});

describe('OrgStatusTiles as links', () => {
  it('links each tile to its list and marks partial counts', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <OrgStatusTiles
          counts={{ all: 500, active: 400, pending: 0, inactive: 100 }}
          more
          hrefs={{
            all: '/console/orgs?view=list',
            active: '/console/orgs?status=active',
            pending: '/console/orgs?status=pending',
            inactive: '/console/orgs?status=inactive',
          }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('link', { name: /^Organisations\s*500\+/ })).toHaveAttribute(
      'href',
      '/console/orgs?view=list',
    );
    expect(
      screen.getByRole('link', { name: /^Pending review\s*0\+\s*Nothing to review/ }),
    ).toHaveAttribute('href', '/console/orgs?status=pending');
  });
});

describe('NetworkOrgsView', () => {
  it('starts as a tree under the network', () => {
    renderView();
    expect(screen.getByText('Blue Dots')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edge Org B' })).toHaveAttribute(
      'href',
      '/console/orgs/b',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('opens the list with a filter when a tile is picked', () => {
    renderView();
    fireEvent.click(tile(/^Pending review\s*1/));
    expect(tile(/^Pending review\s*1/)).toHaveAttribute('aria-pressed', 'true');
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('Cotton Co')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View Cotton Co' })).toHaveAttribute(
      'href',
      '/console/orgs/c',
    );
  });

  it('searches names and "known as" in the list', () => {
    renderView({ initialView: 'list' });
    expect(rows()).toHaveLength(4);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search organisations' }), {
      target: { value: 'cluster' },
    });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });
    expect(screen.getByText(messages.console.orgs.empty)).toBeInTheDocument();
  });

  it('filters by status and switches back to the tree', () => {
    renderView({ initialView: 'list', initialFilter: 'inactive' });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('Dropped Org')).toBeInTheDocument();
    const filter = screen.getByRole('group', { name: 'Show organisations' });
    fireEvent.click(within(filter).getByRole('button', { name: 'All' }));
    expect(rows()).toHaveLength(4);
    const view = screen.getByRole('group', { name: 'Show as' });
    fireEvent.click(within(view).getByRole('button', { name: 'Tree' }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows pending coordinators beside the count', () => {
    renderView({ initialView: 'list' });
    const a = rows().find((r) => r.textContent?.includes('Edge Org A'))!;
    expect(a).toHaveTextContent('54');
    expect(a).toHaveTextContent('10 pending');
  });
});
