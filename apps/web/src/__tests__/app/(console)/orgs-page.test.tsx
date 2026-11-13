/**
 * Server Component test: `(console)/console/orgs`. Each list holds the
 * organisations and the unused invites together under a card with the Invite
 * button; the network admin's hierarchy settings get the network's values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  KnownAsValues,
  MeResponse,
  OrgHierarchyResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({ consoleRead: vi.fn() }));
vi.mock('@/lib/console-hierarchy.server', () => ({
  readNetworkOrgs: vi.fn(async () => ({ orgs: [], more: false })),
  readReachableOrgs: vi.fn(async () => []),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
  getFormatter: vi.fn(async () => ({ dateTime: () => '13 Nov 2026' })),
}));
vi.mock('@/lib/console-invites.server', () => ({ readOpenInvites: vi.fn(async () => null) }));
vi.mock('@/components/console/ConsoleOrgCard', () => ({
  ConsoleOrgCard: ({ name, action }: { name: string; action?: React.ReactNode }) => (
    <div data-testid="org-card">
      {name}
      {action}
    </div>
  ),
}));
vi.mock('@/components/console/MemberList', () => ({
  MemberList: ({
    rows,
    counts,
    initialFilter,
  }: {
    rows: Array<{ id: string; status: string; detail: string | null }>;
    counts: Record<string, string>;
    initialFilter?: string;
  }) => (
    <div data-testid="list" data-filter={initialFilter} data-counts={JSON.stringify(counts)}>
      {rows.map((r) => `${r.id}:${r.status}:${r.detail ?? ''}`).join(',')}
    </div>
  ),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}));
vi.mock('@/components/console/HierarchySettings', () => ({
  HierarchySettings: ({ orgId, values }: { orgId: string; values: KnownAsValues }) => (
    <div data-testid="hierarchy-settings" data-org-id={orgId}>
      {values.map((v) => v.name).join(',')}
    </div>
  ),
}));

import ConsoleOrgsPage from '@/app/(console)/console/orgs/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readNetworkOrgs, readReachableOrgs } from '@/lib/console-hierarchy.server';
import { readOpenInvites } from '@/lib/console-invites.server';

const NETWORK_ADMIN: MeResponse = {
  kind: 'admin',
  user: { id: 'na', contact: { name: null, email: 'na@x.org', phone: null } },
  orgs: [
    {
      id: 'root',
      name: 'The Network',
      slug: 'network',
      org_type: 'network_facilitator',
      role: 'owner',
      is_default: false,
      capabilities: ['orgs.onboard'],
    },
  ],
  is_network_admin: true,
};

const VALUES: KnownAsValues = [{ key: 'state', name: 'State', default: true }];

describe('console orgs page — hierarchy settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: NETWORK_ADMIN } as never);
    vi.mocked(consoleRead).mockImplementation(async (path: string) => {
      if (path === '/v1/org/hierarchy?fields=known_as_values') {
        return {
          network: { id: 'root', name: 'The Network', known_as_values: VALUES },
          limits: { max_depth: 2, max_children: null, max_total_orgs: 50 },
          total_orgs: 0,
        } satisfies OrgHierarchyResponse as never;
      }
      throw new Error(`unexpected read ${path}`);
    });
  });

  it("reads the hierarchy with the network's values and passes them to the settings", async () => {
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({}) }));
    expect(consoleRead).toHaveBeenCalledWith('/v1/org/hierarchy?fields=known_as_values');
    expect(screen.getByTestId('hierarchy-settings')).toHaveTextContent('State');
  });

  it('lists joined, registered and invited organisations in one list, Default not counted', async () => {
    vi.mocked(readNetworkOrgs).mockResolvedValueOnce({
      orgs: [
        { id: 'd', name: 'Default', parent_id: 'root', status: 'active', is_default: true },
        {
          id: 'x',
          name: 'Joined',
          parent_id: 'root',
          status: 'active',
          is_default: false,
          known_as: 'state',
        },
        { id: 'y', name: 'Waiting', parent_id: 'root', status: 'pending', is_default: false },
      ],
      more: false,
    } as never);
    vi.mocked(readOpenInvites).mockResolvedValueOnce({
      invites: [
        {
          email: 'new@org.test',
          status: 'pending',
          created_at: '2026-11-13T06:00:00Z',
          expires_at: '2026-11-20T06:00:00Z',
        },
      ],
      next_cursor: null,
    });
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({ status: 'pending' }) }));
    const list = screen.getByTestId('list');
    expect(list).toHaveTextContent(
      'x:active:state,y:pending:,d:active:,invite:new@org.test:pending:console.sent_on',
    );
    expect(JSON.parse(list.dataset.counts ?? '')).toEqual({ all: '3', active: '1', pending: '2' });
    expect(list).toHaveAttribute('data-filter', 'pending');
    expect(screen.getByTestId('org-card')).toHaveTextContent('The Network');
    expect(screen.getByRole('link', { name: /console\.orgs\.invite/ })).toHaveAttribute(
      'href',
      '/console/orgs/invite',
    );
  });
});

describe('console orgs page — owner view', () => {
  const owner = (role: 'owner' | 'member' = 'owner'): MeResponse => ({
    kind: 'admin',
    user: { id: 'owner', contact: { name: null, email: 'owner@a.org', phone: null } },
    orgs: [
      {
        id: 'a',
        name: 'Org A',
        slug: 'org-a',
        org_type: 'aggregator',
        role,
        is_default: false,
        capabilities: ['org.manage'],
      },
    ],
    is_network_admin: false,
  });

  /** The values Org A defines for its children; null when it cannot have any. */
  function mockOwner(opts: { role?: 'owner' | 'member'; status?: string; values?: unknown } = {}) {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: owner(opts.role) } as never);
    vi.mocked(readReachableOrgs).mockResolvedValue([
      { id: 'a', name: 'Org A', parent_id: 'root', status: opts.status ?? 'active', depth: 1 },
    ] as never);
    vi.mocked(consoleRead).mockImplementation(async (path: string) => {
      if (path === '/v1/org/read/a?fields=known_as_values') {
        return {
          org: { id: 'a', known_as_values: opts.values === undefined ? [] : opts.values },
        } as never;
      }
      throw new Error(`unexpected read ${path}`);
    });
  }

  // The owner view is an async server component, resolved here as Next would.
  async function showOwner() {
    const page = (await ConsoleOrgsPage({
      searchParams: Promise.resolve({}),
    })) as React.ReactElement<
      Record<string, unknown>,
      (props: Record<string, unknown>) => Promise<React.ReactElement>
    >;
    render(await page.type(page.props));
  }

  beforeEach(() => vi.clearAllMocks());

  it('hides Invite organisations from an owner without orgs.onboard', async () => {
    mockOwner();
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: {
        ...owner(),
        capabilities: ['org.manage'],
        orgs: [{ ...owner().orgs[0]!, capabilities: ['org.manage'] }],
      },
    } as never);
    await showOwner();
    expect(screen.queryByRole('link', { name: /console\.orgs\.invite/ })).toBeNull();
  });

  it('puts the Invite organisations button on the card of each owned organisation', async () => {
    mockOwner();
    await showOwner();
    expect(screen.getByTestId('org-card')).toHaveTextContent('Org A');
    expect(screen.queryByRole('link', { name: 'console.orgs.manage' })).toBeNull();
    expect(screen.getByRole('link', { name: /console\.orgs\.invite/ })).toHaveAttribute(
      'href',
      '/console/orgs/invite',
    );
  });

  it('shows the "known as" values editor for an active organisation the viewer owns', async () => {
    mockOwner();
    await showOwner();
    expect(screen.getByTestId('hierarchy-settings')).toHaveAttribute('data-org-id', 'a');
  });

  it('hides the editor when the organisation cannot have child organisations', async () => {
    mockOwner({ values: null });
    await showOwner();
    expect(screen.queryByTestId('hierarchy-settings')).toBeNull();
  });

  it('lists the organisations under the owned one, those still to verify included', async () => {
    mockOwner();
    vi.mocked(readReachableOrgs).mockResolvedValue([
      { id: 'a', name: 'Org A', parent_id: 'root', status: 'active', depth: 1 },
      { id: 'b', name: 'Org B', parent_id: 'a', status: 'active', depth: 2 },
      { id: 'c', name: 'Org C', parent_id: 'a', status: 'pending', depth: 2 },
    ] as never);
    await showOwner();
    expect(screen.getByTestId('list')).toHaveTextContent(/^b:active:,c:pending:$/);
  });

  it('hides the editor from a member and on a pending organisation, without reading the values', async () => {
    mockOwner({ role: 'member' });
    await showOwner();
    mockOwner({ status: 'pending' });
    await showOwner();
    expect(screen.queryByTestId('hierarchy-settings')).toBeNull();
    expect(consoleRead).not.toHaveBeenCalled();
  });
});
