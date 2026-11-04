/**
 * Server Component test: `(console)/console/orgs/[id]`. The owner of an active
 * organisation gets the editor for the "known as" values of the organisations
 * under it; the owner of a pending or rejected one, and a viewer who is not
 * the owner, do not. A viewer who picks the org's "known as" value gets the
 * picker, the matching banner, and a details form without that value.
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
vi.mock('@/lib/console-api.server', () => ({
  consoleRead: vi.fn(),
  consoleReadOptional: vi.fn(async () => null),
}));
vi.mock('@/lib/org-schema.server', () => ({ loadOrgSchema: vi.fn(async () => null) }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
  getFormatter: vi.fn(async () => ({ dateTime: () => '1 Jan 2026' })),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}));
vi.mock('@/components/console/OrgEditForm', () => ({
  OrgEditForm: ({ knownAsPicked }: { knownAsPicked?: boolean }) => (
    <div data-testid="org-edit-form" data-known-as-picked={String(knownAsPicked)} />
  ),
}));
vi.mock('@/components/console/KnownAsPicker', () => ({
  KnownAsPicker: () => <div data-testid="known-as-picker" />,
}));
vi.mock('@/components/console/OrgMoveDialog', () => ({ OrgMoveDialog: () => null }));
vi.mock('@/components/console/ChildOrgsTree', () => ({ ChildOrgsTree: () => null }));
vi.mock('@/components/console/RolesPanel', () => ({ RolesPanel: () => null }));
vi.mock('@/components/console/OwnerAccessRepair', () => ({ OwnerAccessRepair: () => null }));
vi.mock('@/components/console/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('@/components/console/KnownAsValuesEditor', () => ({
  KnownAsValuesEditor: () => <div data-testid="known-as-values-editor" />,
}));

import ConsoleOrgPage from '@/app/(console)/console/orgs/[id]/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';

type Org = OrgReadResponse['org'];

const ORG_ID = 'o1';

const org = (over: Partial<Org> = {}): Org =>
  ({
    id: ORG_ID,
    slug: 'alpha',
    name: 'Alpha',
    org_type: 'aggregator',
    status: 'active',
    is_default: false,
    url: null,
    locations: [],
    legal_name: null,
    gst_number: null,
    known_as: 'aggregator',
    known_as_name: 'Aggregator',
    depth: 1,
    parent_id: 'root',
    parent_name: 'The Network',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }) as Org;

const me = (userId: string, ownOrgId = ORG_ID): MeResponse => ({
  kind: 'admin',
  user: { id: userId, contact: { name: null, email: 'owner@a.org', phone: null } },
  orgs: [
    {
      id: ownOrgId,
      name: 'Alpha',
      slug: 'alpha',
      org_type: 'aggregator',
      role: 'owner',
      is_default: false,
      capabilities: ['org.manage'],
    },
  ],
  is_network_admin: false,
});

interface PageOptions {
  /** The org the viewer owns. */
  viewerOrgId?: string;
  knownAsOptions?: OrgReadResponse['known_as_options'];
  /** The org's own list; null when it cannot have child orgs. */
  knownAsValues?: OrgReadResponse['org']['known_as_values'];
}

function mockPage(target: OrgReadResponse['org'], viewerId = 'owner', opts: PageOptions = {}) {
  vi.mocked(getConsoleActor).mockResolvedValue({
    ok: true,
    me: me(viewerId, opts.viewerOrgId),
  } as never);
  vi.mocked(consoleRead).mockImplementation(async (path: string) => {
    // The page asks for both lists in its one read.
    if (path === `/v1/org/read/${ORG_ID}?fields=known_as_values,known_as_options`) {
      return {
        org: {
          ...target,
          known_as_values:
            opts.knownAsValues === undefined
              ? [{ key: 'block', name: 'Block' }]
              : opts.knownAsValues,
        },
        owner: { id: 'owner', contact: { name: null, email: 'owner@a.org', phone: null } },
        coordinator_count: 0,
        child_count: 0,
        pending_count: 0,
        known_as_options: opts.knownAsOptions ?? null,
      } satisfies OrgReadResponse as never;
    }
    if (path === '/v1/org/search') {
      return { orgs: [], next_cursor: null } satisfies OrgSearchResponse as never;
    }
    throw new Error(`unexpected read ${path}`);
  });
}

const show = async () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {await ConsoleOrgPage({ params: Promise.resolve({ id: ORG_ID }) })}
    </NextIntlClientProvider>,
  );

describe('console org detail — child "known as" editor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the editor to the owner of an active organisation', async () => {
    mockPage(org());
    await show();
    expect(screen.getByTestId('known-as-values-editor')).toBeInTheDocument();
  });

  it.each(['pending', 'inactive'] as const)(
    'hides the editor on a %s organisation',
    async (status) => {
      mockPage(org({ status }));
      await show();
      expect(screen.queryByTestId('known-as-values-editor')).toBeNull();
    },
  );

  it('hides the editor from a viewer who is not the owner', async () => {
    mockPage(org(), 'someone-else');
    await show();
    expect(screen.queryByTestId('known-as-values-editor')).toBeNull();
  });

  it('hides the editor when the organisation cannot have child organisations', async () => {
    mockPage(org(), 'owner', { knownAsValues: null });
    await show();
    expect(screen.queryByTestId('known-as-values-editor')).toBeNull();
  });
});

describe('console org detail — "known as" picker', () => {
  beforeEach(() => vi.clearAllMocks());

  const OPTIONS = [{ key: 'block', name: 'Block' }];

  it('shows the picker, its banner and a details form without the value to the parent owner', async () => {
    mockPage(org({ depth: 2 }), 'parent-owner', {
      viewerOrgId: 'parent',
      knownAsOptions: OPTIONS,
    });
    await show();
    expect(screen.getByTestId('known-as-picker')).toBeInTheDocument();
    expect(screen.getByText('console.org.viewed_from_above_known_as')).toBeInTheDocument();
    expect(screen.queryByText('console.org.viewed_from_above')).toBeNull();
    expect(screen.getByTestId('org-edit-form')).toHaveAttribute('data-known-as-picked', 'true');
  });

  it('keeps the view-only banner and the value in the form for an ancestor that does not pick', async () => {
    mockPage(org({ depth: 3 }), 'grandparent-owner', { viewerOrgId: 'grandparent' });
    await show();
    expect(screen.queryByTestId('known-as-picker')).toBeNull();
    expect(screen.getByText('console.org.viewed_from_above')).toBeInTheDocument();
    expect(screen.getByTestId('org-edit-form')).toHaveAttribute('data-known-as-picked', 'false');
  });
});
