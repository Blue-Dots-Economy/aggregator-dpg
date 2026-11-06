/**
 * Server Component test: `(console)/console/orgs` for the network admin. The
 * page reads the hierarchy with `fields=known_as_values`, so the hierarchy
 * settings get the network's "known as" values.
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
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}));
vi.mock('@/components/console/ConsoleUi', () => ({
  ConsoleCollapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConsoleSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  EmptyState: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/console/OrgsTable', () => ({ OrgsTable: () => null }));
vi.mock('@/components/console/NetworkOrgsView', () => ({ NetworkOrgsView: () => null }));
vi.mock('@/components/console/ChildOrgsTree', () => ({ ChildOrgsTree: () => null }));
vi.mock('@/components/console/HierarchySettings', () => ({
  HierarchySettings: ({ hierarchy }: { hierarchy: OrgHierarchyResponse }) => (
    <div data-testid="hierarchy-settings">
      {(hierarchy.network.known_as_values ?? []).map((v) => v.name).join(',')}
    </div>
  ),
}));

import ConsoleOrgsPage from '@/app/(console)/console/orgs/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';
import { OrgHierarchyResponseSchema } from '@aggregator-dpg/shared-primitives/user-org';

const NETWORK_ADMIN: MeResponse = {
  kind: 'admin',
  user: { id: 'na', contact: { name: null, email: 'na@x.org', phone: null } },
  orgs: [],
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

  it('shows the review box even when nothing is waiting, with where requests appear', async () => {
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/orgs\.empty_pending.*orgs\.review_hint/)).toBeInTheDocument();
  });

  it("reads the hierarchy with the network's values and passes them to the settings", async () => {
    render(await ConsoleOrgsPage({ searchParams: Promise.resolve({}) }));
    expect(consoleRead).toHaveBeenCalledWith(
      '/v1/org/hierarchy?fields=known_as_values',
      OrgHierarchyResponseSchema,
    );
    expect(screen.getByTestId('hierarchy-settings')).toHaveTextContent('State');
  });
});
