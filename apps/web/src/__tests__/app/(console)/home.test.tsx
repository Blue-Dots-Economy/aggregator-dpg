/**
 * Server Component test: `(console)/console` home. An owner of one
 * organisation gets the organisation view with its coordinators and a summary
 * of the organisations below it; an owner of several keeps the organisation
 * cards. An owner's own orgs are read by id, so they show even when many orgs
 * below them sort first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  MeOrg,
  MeResponse,
  OrgReadResponse,
  OrgSearchResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({ consoleRead: vi.fn() }));
vi.mock('@/lib/console-hierarchy.server', () => ({ readReachableOrgs: vi.fn() }));
vi.mock('@/lib/console-domains.server', () => ({
  consoleNetwork: vi.fn(async () => ({ id: 'blue_dot', domains: [] })),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `console.${key} ${JSON.stringify(values)}` : `console.${key}`,
  ),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import ConsoleHomePage from '@/app/(console)/console/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { readReachableOrgs } from '@/lib/console-hierarchy.server';

type Row = OrgSearchResponse['orgs'][number];

const row = (id: string, name: string, over: Partial<Row> = {}): Row => ({
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
  depth: 2,
  parent_id: null,
  parent_name: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 2,
  child_count: 0,
  pending_count: 1,
  ...over,
});

const meOrg = (id: string, name: string, over: Partial<MeOrg> = {}): MeOrg => ({
  id,
  name,
  slug: id,
  org_type: 'aggregator',
  role: 'owner',
  is_default: false,
  capabilities: ['org.manage'],
  ...over,
});

const me = (orgs: MeOrg[], over: Partial<MeResponse> = {}): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'owner@a.org', phone: null } },
  orgs,
  is_network_admin: false,
  ...over,
});

const users: UserSearchResponse = {
  users: [
    {
      id: 'c1',
      name: 'Edge Org A',
      status: 'active',
      serves: [],
      contact: { name: 'Coord One', email: 'c1@edge.test', phone: null },
    },
    {
      id: 'c2',
      name: 'Edge Org A',
      status: 'pending',
      serves: [],
      contact: { name: null, email: 'cp@edge.test', phone: null },
    },
  ],
  next_cursor: null,
} as unknown as UserSearchResponse;

/** Answers the org reads by id and the coordinator search. */
function mockReads(own: Row[], below: Row[] = []) {
  vi.mocked(consoleRead).mockImplementation(async (path: string) => {
    const found = own.find((o) => path === `/v1/org/read/${o.id}`);
    if (found) {
      const { coordinator_count, child_count, pending_count, ...org } = found;
      return {
        org,
        owner: { id: 'u', contact: { name: null, email: 'owner@a.org', phone: null } },
        coordinator_count,
        child_count,
        pending_count,
      } satisfies OrgReadResponse as never;
    }
    if (path === '/v1/user/search') return users as never;
    throw new Error(`unexpected read ${path}`);
  });
  vi.mocked(readReachableOrgs).mockResolvedValue([...below, ...own]);
}

const show = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {await ConsoleHomePage()}
    </NextIntlClientProvider>,
  );

describe('console home — owner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an owner of one organisation that organisation and its coordinators', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me([meOrg('org-1', 'Edge Org A')]),
    });
    mockReads([row('org-1', 'Edge Org A')]);
    await show();
    expect(screen.getByRole('heading', { name: 'console.org_home.heading' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /console\.org_home\.invite/ })).toHaveAttribute(
      'href',
      '/console/invite',
    );
    expect(screen.getByText('Coord One')).toBeInTheDocument();
    expect(screen.getByText('cp@edge.test')).toBeInTheDocument();
    expect(consoleRead).toHaveBeenCalledWith('/v1/user/search', {
      filter: { org_id: 'org-1' },
      limit: 100,
    });
  });

  it('keeps the summary of the organisations below on the organisation view', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me([meOrg('own', 'Zeta Own')]),
    });
    const below = Array.from({ length: 100 }, (_, i) => row(`b${i}`, `Alpha ${i}`));
    mockReads([row('own', 'Zeta Own')], below);
    await show();
    expect(screen.getByText('Zeta Own')).toBeInTheDocument();
    expect(screen.getByText(/home\.below_summary.*"orgs":100/)).toBeInTheDocument();
  });

  it('keeps the organisation cards for an owner of several organisations', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me([meOrg('org-1', 'Edge Org A'), meOrg('org-2', 'Edge Org B')]),
    });
    mockReads([row('org-1', 'Edge Org A'), row('org-2', 'Edge Org B')]);
    await show();
    expect(screen.getByRole('heading', { name: 'console.home.heading' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edge Org B' })).toHaveAttribute(
      'href',
      '/console/orgs/org-2',
    );
    expect(consoleRead).not.toHaveBeenCalledWith('/v1/user/search', expect.anything());
  });

  it('hides Invite when the owner cannot invite', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: { ...me([meOrg('org-1', 'Edge Org A', { capabilities: [] })]), capabilities: [] },
    });
    mockReads([row('org-1', 'Edge Org A')]);
    await show();
    expect(
      screen.queryByRole('link', { name: /console\.org_home\.invite/ }),
    ).not.toBeInTheDocument();
  });
});
