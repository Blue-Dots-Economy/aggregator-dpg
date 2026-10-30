/**
 * Server Component test: `(console)/console` home. An owner's own orgs are
 * read by id, so they show even when many orgs below them sort first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  MeResponse,
  OrgReadResponse,
  OrgSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({ consoleRead: vi.fn() }));
vi.mock('@/lib/console-hierarchy.server', () => ({ readReachableOrgs: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
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

const row = (id: string, name: string): Row => ({
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
  coordinator_count: 1,
  child_count: 0,
  pending_count: 0,
});

const me: MeResponse = {
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [
    {
      id: 'own',
      name: 'Zeta Own',
      slug: 'own',
      org_type: 'aggregator',
      role: 'owner',
      is_default: false,
      capabilities: ['org.manage'],
    },
  ],
  is_network_admin: false,
};

describe('console home — owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me });
  });

  it('shows an own org that sorts after 100 orgs below it', async () => {
    const below = Array.from({ length: 100 }, (_, i) => row(`b${i}`, `Alpha ${i}`));
    const own = { ...row('own', 'Zeta Own'), coordinator_count: 7 };
    vi.mocked(consoleRead).mockImplementation(async (path: string) => {
      if (path === '/v1/org/read/own') {
        const { coordinator_count, child_count, pending_count, ...org } = own;
        return {
          org,
          owner: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
          coordinator_count,
          child_count,
          pending_count,
        } satisfies OrgReadResponse;
      }
      // One search page: the 100 orgs below, the owner's own org on the next page.
      if (path === '/v1/org/search') return { orgs: below, next_cursor: 'c' };
      throw new Error(`unexpected read ${path}`);
    });
    vi.mocked(readReachableOrgs).mockResolvedValue([...below, own]);

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {await ConsoleHomePage()}
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole('link', { name: 'Zeta Own' })).toHaveAttribute(
      'href',
      '/console/orgs/own',
    );
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/home\.below_summary.*"orgs":100/)).toBeInTheDocument();
  });
});
