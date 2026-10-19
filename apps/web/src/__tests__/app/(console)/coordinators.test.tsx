/**
 * Server Component test: `(console)/console/coordinators` — the Invite
 * coordinators button beside the status filter (#873). The button replaces
 * the old sidebar entry, so it must be gated the same way `canInvite` gated
 * that entry: offered to an org owner who manages a real organisation (or
 * holds `org.manage` in the root), withheld from a network admin who only
 * has the read-only `network.administer` view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  MeOrg,
  MeResponse,
  UserSearchResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('@/lib/console-actor', () => ({ getConsoleActor: vi.fn() }));
vi.mock('@/lib/console-api.server', () => ({
  consoleRead: vi.fn(),
  consoleReadOptional: vi.fn(),
}));
vi.mock('@/lib/console-domains.server', () => ({
  networkDomains: vi.fn(async () => []),
  servedLabels: vi.fn(() => null),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => `console.${key}`),
}));
vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
}));

import ConsoleCoordinatorsPage from '@/app/(console)/console/coordinators/page';
import { getConsoleActor } from '@/lib/console-actor';
import { consoleRead } from '@/lib/console-api.server';

const org = (over: Partial<MeOrg>): MeOrg => ({
  id: 'org-1',
  name: 'Real Org',
  slug: 'real-org',
  org_type: 'aggregator',
  role: 'owner',
  is_default: false,
  capabilities: ['org.manage'],
  ...over,
});

const me = (over: Partial<MeResponse>): MeResponse => ({
  kind: 'admin',
  user: { id: 'u', contact: { name: null, email: 'a@a.org', phone: null } },
  orgs: [],
  is_network_admin: false,
  ...over,
});

const emptyPage: UserSearchResponse = { users: [], next_cursor: null };

const show = (el: Awaited<ReturnType<typeof ConsoleCoordinatorsPage>>) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {el}
    </NextIntlClientProvider>,
  );

const renderPage = () => ConsoleCoordinatorsPage({ searchParams: Promise.resolve({}) });

describe('console coordinators page — invite button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(consoleRead).mockResolvedValue(emptyPage);
  });

  it('offers Invite to an org owner managing a real organisation', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ orgs: [org({})] }) });
    show(await renderPage());
    const link = screen.getByRole('link', { name: /console\.nav\.invite/ });
    expect(link).toHaveAttribute('href', '/console/invite');
  });

  it('withholds Invite from a network admin with only the read-only view', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({
      ok: true,
      me: me({
        is_network_admin: true,
        capabilities: ['network.administer'],
        orgs: [org({ org_type: 'network_facilitator', capabilities: ['network.administer'] })],
      }),
    });
    show(await renderPage());
    expect(screen.queryByRole('link', { name: /console\.nav\.invite/ })).not.toBeInTheDocument();
  });

  it('offers Invite to everyone when access control is off', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: true, me: me({ capabilities: null }) });
    show(await renderPage());
    expect(screen.getByRole('link', { name: /console\.nav\.invite/ })).toBeInTheDocument();
  });

  it('shows no Invite button when the actor cannot be read', async () => {
    vi.mocked(getConsoleActor).mockResolvedValue({ ok: false, reason: 'unavailable' });
    show(await renderPage());
    expect(screen.queryByRole('link', { name: /console\.nav\.invite/ })).not.toBeInTheDocument();
  });
});
