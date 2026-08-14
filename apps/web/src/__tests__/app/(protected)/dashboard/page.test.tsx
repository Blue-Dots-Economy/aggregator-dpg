/**
 * Full-page composition test: `(protected)/dashboard/page.tsx`.
 *
 * The dashboard is a single ~2200-line file with no sub-exports, so every
 * section (loading frame, tab shell, summary bar, stat cards, tile groups,
 * participant table, lifecycle/status filters, bulk selection + actions,
 * pagination, refresh) is exercised through the one default export,
 * `DashboardPageRoot`.
 *
 * Data + config hooks (`useDashboard`, `useOppProviders`, `useAggregatorConfig`,
 * `useProfileRaw`) and the two service modules the page calls directly
 * (`dashboardService`, `DASHBOARD_BULK_ACTIONS`) are mocked as black boxes per
 * their exported shapes — no real network/BFF calls. `Topbar` and `Sidebar`-
 * adjacent chrome is not involved here (dashboard page renders no Sidebar);
 * `Topbar` itself is stubbed since its internals (language switcher, theme
 * toggle) are out of scope for this file and pull in Radix/next-intl chrome
 * unrelated to dashboard logic.
 *
 * Note on lifecycle filtering: the page's own `LIFECYCLE_FILTER_VALUES` is
 * `['all', 'draft', 'live']` only — `paused`/`account_only` are values the
 * `/v1/dashboard/items` API-level filter supports (see root CLAUDE.md) but
 * this page's dropdown does not surface them today, so only `all`/`draft`/
 * `live` are exercised below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ThemeModeProvider } from '@/lib/theme-mode';
import messages from '@/i18n/messages/en.json';

// ---------------------------------------------------------------------------
// next/navigation — locally overridden (not the global setup.ts stub) so the
// `?lifecycle=` URL round-trip (`useLifecycleUrlFilter`) is actually
// observable. `replace()` updates a tiny external store and notifies
// subscribers via `useSyncExternalStore`, so a component reading
// `useSearchParams()` re-renders the same way it would under the real
// Next.js router. Built inside `vi.hoisted` so the (hoisted) `vi.mock` factory
// below can close over it without hitting the module TDZ.
// ---------------------------------------------------------------------------
const nav = vi.hoisted(() => {
  let searchParamsState = new URLSearchParams();
  let listeners: Array<() => void> = [];
  const subscribe = (listener: () => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  };
  const getSnapshot = () => searchParamsState;
  const push = { fn: null as unknown };
  const replace = { fn: null as unknown };
  const resetSearchParams = (init?: string) => {
    searchParamsState = new URLSearchParams(init ?? '');
    listeners.forEach((l) => l());
  };
  return { subscribe, getSnapshot, push, replace, resetSearchParams };
});
// `vi.fn` itself is safe to call inside `vi.hoisted`, but assigning it to a
// plain top-level const (read by the `vi.mock` factory below) is not — hence
// the indirection above, populated here where normal module order applies.
nav.push.fn = vi.fn();
nav.replace.fn = vi.fn((url: string) => {
  const qIndex = url.indexOf('?');
  nav.resetSearchParams(qIndex >= 0 ? url.slice(qIndex + 1) : undefined);
});
const mockPush = nav.push.fn as ReturnType<typeof vi.fn>;
const mockReplace = nav.replace.fn as ReturnType<typeof vi.fn>;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => (nav.push.fn as (...a: unknown[]) => unknown)(...args),
    replace: (...args: unknown[]) => (nav.replace.fn as (...a: unknown[]) => unknown)(...args),
  }),
  usePathname: () => '/dashboard',
  useSearchParams: () => useSyncExternalStore(nav.subscribe, nav.getSnapshot, nav.getSnapshot),
}));

vi.mock('@/components/shell/Topbar', () => ({
  Topbar: ({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) => (
    <div data-testid="topbar">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      <div>{right}</div>
    </div>
  ),
}));

const mockUseDashboard = vi.fn();
const mockUseOppProviders = vi.fn();
vi.mock('@/hooks/useDashboard', () => ({
  useDashboard: (...args: unknown[]) => mockUseDashboard(...args),
  useOppProviders: (...args: unknown[]) => mockUseOppProviders(...args),
}));

// `vi.hoisted` so these fixtures exist before the (hoisted) `vi.mock` factory
// below — which also runs at module-evaluation time — reads them.
const { CFG_FIXTURE, TWO_DOMAIN_CFG_FIXTURE } = vi.hoisted(() => {
  const cfg = {
    aggregator: { name: 'Test Aggregator' },
    brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Portal', tagline: 'Test tagline' },
    network: { id: 'blue_dot' },
    domains: [{ id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' }],
    dashboardBuckets: {},
  };
  const twoDomainCfg = {
    ...cfg,
    domains: [
      { id: 'seeker', label: 'Seeker', plural_label: 'Seekers', item_type: 'profile_1.0' },
      {
        id: 'provider',
        label: 'Provider',
        plural_label: 'Providers',
        item_type: 'job_posting_1.0',
      },
    ],
  };
  return { CFG_FIXTURE: cfg, TWO_DOMAIN_CFG_FIXTURE: twoDomainCfg };
});
const mockUseAggregatorConfig = vi.fn(() => ({ data: CFG_FIXTURE }));
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => mockUseAggregatorConfig(),
  DEFAULT_AGGREGATOR_CONFIG: CFG_FIXTURE,
}));

const mockUseProfileRaw = vi.fn(() => ({ data: { type: 'seeker' } }));
vi.mock('@/hooks/useProfile', () => ({
  useProfileRaw: () => mockUseProfileRaw(),
}));

const mockDashboardServiceDashboard = vi.fn();
vi.mock('@/services/dashboard.service', () => ({
  dashboardService: {
    dashboard: (...args: unknown[]) => mockDashboardServiceDashboard(...args),
  },
}));

const runExportSelected = vi.fn(async () => {});
vi.mock('@/services/bulk-actions', () => ({
  DASHBOARD_BULK_ACTIONS: [
    {
      id: 'export_selected_csv',
      labelKey: 'bulk.exportSelected',
      icon: 'download',
      kind: 'client',
      run: (...args: unknown[]) => runExportSelected(...args),
    },
  ],
}));

import DashboardPageRoot from '@/app/(protected)/dashboard/page';

function renderPage(ui: ReactElement = <DashboardPageRoot />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <ThemeModeProvider>{ui}</ThemeModeProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Builds a raw `/api/dashboard` item, shaped as `toSeekerRow` expects. */
function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile_item_id: 'p1',
    name: 'Alice Seeker',
    profile_status: 'active',
    profile_completion_pct: 100,
    profile_created_at: '2024-01-01T00:00:00.000Z',
    profile_last_updated_at: '2024-01-02T00:00:00.000Z',
    initiated: { create: 1, accept: 0, reject: 0, cancel: 0 },
    received: { create: 0, accept: 0, reject: 0, cancel: 0 },
    actionable_tags: [],
    ...overrides,
  };
}

function rollupFixture(overrides: Record<string, unknown> = {}) {
  return {
    total_items: 120,
    complete_profiles: 80,
    has_applications: 40,
    by_status: { new: 10, active: 90, at_risk: 15, inactive: 5 },
    by_initiated_action_status: { create: 5, accept: 3, reject: 1, cancel: 0 },
    by_received_action_status: { create: 2, accept: 1, reject: 0, cancel: 0 },
    total_users: 100,
    avg_items_per_user: 1.2,
    avg_actions_per_user: 0.5,
    mode_wise_counts: {},
    ...overrides,
  };
}

function dashboardPageFixture(
  opts: {
    domain?: string;
    items?: Record<string, unknown>[];
    rollup?: Record<string, unknown>;
    totalMatching?: number;
  } = {},
) {
  const domain = opts.domain ?? 'seeker';
  const items = opts.items ?? [
    rawItem({ profile_item_id: 'p1', name: 'Alice Seeker', profile_completion_pct: 100 }),
    rawItem({
      profile_item_id: 'p2',
      name: 'Bob Draft',
      profile_status: 'new',
      profile_completion_pct: 40,
      profile_created_at: '2024-01-05T00:00:00.000Z',
    }),
  ];
  return {
    by_domain: {
      [domain]: {
        rollup: rollupFixture(opts.rollup),
        items,
        total_matching: opts.totalMatching ?? items.length,
        next_cursor: null,
      },
    },
    metadata: { last_computed_at: '2024-01-01T00:00:00.000Z', ttl_seconds: 60, refreshed: false },
  };
}

describe('<DashboardPageRoot />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.resetSearchParams();
    mockUseAggregatorConfig.mockReturnValue({ data: CFG_FIXTURE });
    mockUseProfileRaw.mockReturnValue({ data: { type: 'seeker' } });
    mockUseOppProviders.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockUseDashboard.mockReturnValue({
      data: dashboardPageFixture(),
      isLoading: false,
      isError: false,
    });
    mockDashboardServiceDashboard.mockResolvedValue(dashboardPageFixture());
  });

  describe('root loading gate', () => {
    it('renders the loading frame until the profile type resolves', () => {
      mockUseProfileRaw.mockReturnValue({ data: undefined });
      renderPage();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      // Data hooks for the tabs are never reached before the profile resolves.
      expect(mockUseDashboard).not.toHaveBeenCalled();
    });
  });

  describe('shell', () => {
    it('renders the Topbar title/subtitle from aggregator config and an Add Participants action', async () => {
      renderPage();
      expect(screen.getByRole('heading', { name: 'My Blue Dots' })).toBeInTheDocument();
      expect(screen.getByText('Test tagline')).toBeInTheDocument();
      const addBtn = screen.getByRole('button', { name: /Add Participants/i });
      await userEvent.click(addBtn);
      expect(mockPush).toHaveBeenCalledWith('/onboarding');
    });

    it('renders no tab strip for a single-domain aggregator', () => {
      renderPage();
      expect(screen.queryByRole('button', { name: /Seekers/ })).not.toBeInTheDocument();
    });

    it('renders the Providers tab directly when the aggregator profile type is "provider"', () => {
      // `tabItems` always resolves to exactly one entry (seeker XOR provider,
      // picked by the aggregator's own `aggregatorType`) — there is no
      // multi-tab strip to click between in the current implementation, so
      // this exercises `isProviderLike`/`ProvidersTab` via the profile type
      // rather than a tab click.
      mockUseAggregatorConfig.mockReturnValue({ data: TWO_DOMAIN_CFG_FIXTURE });
      mockUseProfileRaw.mockReturnValue({ data: { type: 'provider' } });
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({ domain: 'provider' }),
        isLoading: false,
        isError: false,
      });
      renderPage();
      // Provider-tab-only copy: search placeholder differs from the seeker tab.
      expect(screen.getByPlaceholderText('Search org, role, ID…')).toBeInTheDocument();
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
    });
  });

  describe('SeekersTab data states', () => {
    it('shows the loading card while the dashboard query is in flight', () => {
      mockUseDashboard.mockReturnValue({ data: undefined, isLoading: true, isError: false });
      renderPage();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    it('shows the error card when the dashboard query fails', () => {
      mockUseDashboard.mockReturnValue({ data: undefined, isLoading: false, isError: true });
      renderPage();
      expect(screen.getByText('Failed to load. Please try again.')).toBeInTheDocument();
    });

    it('renders stat cards, tiles, and table rows for a populated response', () => {
      renderPage();
      // SummaryBar total (rollup.total_items).
      expect(screen.getByText('120 total')).toBeInTheDocument();
      // Stat cards, keyed off rollup.by_status.
      expect(screen.getByText('90')).toBeInTheDocument(); // active
      expect(screen.getByText('15')).toBeInTheDocument(); // at_risk
      expect(screen.getByText('5')).toBeInTheDocument(); // inactive
      expect(screen.getByText('10')).toBeInTheDocument(); // new
      // Table rows.
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();
    });

    it('renders the empty state (zero rows, dash-fallback stat cards)', () => {
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({
          items: [],
          rollup: { total_items: 0, complete_profiles: 0, has_applications: 0, by_status: {} },
          totalMatching: 0,
        }),
        isLoading: false,
        isError: false,
      });
      renderPage();
      expect(screen.getByText('0 total')).toBeInTheDocument();
      // active/at_risk/inactive all fall back to the em-dash when absent.
      expect(screen.getAllByText('—').length).toBeGreaterThan(0);
      expect(screen.getByText('Showing 0–0 of 0')).toBeInTheDocument();
    });
  });

  describe('lifecycle filter', () => {
    it('narrows table rows by lifecycle while the stat cards keep reflecting the full rollup', async () => {
      renderPage();
      const select = screen.getByLabelText('Lifecycle');
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();

      await userEvent.selectOptions(select, 'draft');
      expect(screen.queryByText('Alice Seeker')).not.toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();
      // The rollup-driven total is unaffected by the row-level filter.
      expect(screen.getByText('120 total')).toBeInTheDocument();
      expect(mockReplace).toHaveBeenCalledWith('/dashboard?lifecycle=draft', { scroll: false });

      await userEvent.selectOptions(select, 'live');
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.queryByText('Bob Draft')).not.toBeInTheDocument();

      await userEvent.selectOptions(select, 'all');
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();
      expect(mockReplace).toHaveBeenLastCalledWith('/dashboard', { scroll: false });
    });

    it('reads the initial lifecycle value from the URL on mount', () => {
      nav.resetSearchParams('lifecycle=draft');
      renderPage();
      expect(screen.getByLabelText('Lifecycle')).toHaveValue('draft');
      expect(screen.queryByText('Alice Seeker')).not.toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();
    });

    it('falls back an unknown lifecycle URL value to "all"', () => {
      nav.resetSearchParams('lifecycle=bogus');
      renderPage();
      expect(screen.getByLabelText('Lifecycle')).toHaveValue('all');
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();
    });
  });

  describe('status filter popover', () => {
    it('lists rollup-derived status options and refetches with the selected status', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: /All filters/i }));
      const menu = screen.getByRole('menu');
      expect(within(menu).getByText('At Risk')).toBeInTheDocument();
      await userEvent.click(within(menu).getByText('At Risk'));

      await waitFor(() =>
        expect(mockUseDashboard).toHaveBeenLastCalledWith(
          expect.objectContaining({ domain: 'seeker', page: 1, status: 'at_risk' }),
        ),
      );
    });
  });

  describe('search', () => {
    it('filters visible rows client-side and updates the "matching" summary line', async () => {
      renderPage();
      const search = screen.getByLabelText('Search participants');
      await userEvent.type(search, 'Alice');
      expect(screen.getByText('Alice Seeker')).toBeInTheDocument();
      expect(screen.queryByText('Bob Draft')).not.toBeInTheDocument();
      expect(screen.getByText(/Matching 1 of 2/)).toBeInTheDocument();
    });
  });

  describe('pagination', () => {
    it('renders numbered pages when total exceeds the page size and refetches on click', async () => {
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({ totalMatching: 60 }),
        isLoading: false,
        isError: false,
      });
      renderPage();
      const page2 = screen.getByRole('button', { name: '2' });
      await userEvent.click(page2);
      await waitFor(() =>
        expect(mockUseDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
      );
    });

    it('hides page buttons entirely on a single page', () => {
      renderPage();
      expect(screen.queryByRole('button', { name: '2' })).not.toBeInTheDocument();
      expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument();
    });
  });

  describe('refresh', () => {
    it('shows the "refreshed" hint on a successful forced refresh', async () => {
      renderPage();
      const refreshBtn = screen.getByRole('button', { name: /Refresh dashboard/i });
      await userEvent.click(refreshBtn);
      await waitFor(() =>
        expect(mockDashboardServiceDashboard).toHaveBeenCalledWith(
          expect.objectContaining({ domain: 'seeker', refresh: true }),
        ),
      );
      expect(await screen.findByText('Refreshed just now')).toBeInTheDocument();
    });

    it('shows the refresh-failed hint when the forced refresh call rejects', async () => {
      mockDashboardServiceDashboard.mockRejectedValueOnce(new Error('upstream timeout'));
      renderPage();
      const refreshBtn = screen.getByRole('button', { name: /Refresh dashboard/i });
      await userEvent.click(refreshBtn);
      expect(await screen.findByText('Refresh failed')).toBeInTheDocument();
    });
  });

  describe('bulk selection + actions', () => {
    it('selects a row, runs the bulk export action, and shows the success notice', async () => {
      renderPage();
      const rows = screen.getAllByRole('row');
      const aliceRow = rows.find((r) => within(r).queryByText('Alice Seeker'));
      expect(aliceRow).toBeDefined();
      const checkbox = within(aliceRow!).getByRole('checkbox');
      await userEvent.click(checkbox);

      expect(screen.getByText('1 selected')).toBeInTheDocument();
      const exportBtn = screen.getByRole('button', { name: 'Export selected CSV' });
      await userEvent.click(exportBtn);

      await waitFor(() => expect(runExportSelected).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('1 processed')).toBeInTheDocument();
      const [selectedRows] = runExportSelected.mock.calls[0]!;
      expect((selectedRows as { name: string }[])[0]?.name).toBe('Alice Seeker');
    });

    it('shows the failure notice when the bulk action rejects', async () => {
      runExportSelected.mockRejectedValueOnce(new Error('export failed'));
      renderPage();
      const rows = screen.getAllByRole('row');
      const aliceRow = rows.find((r) => within(r).queryByText('Alice Seeker'));
      await userEvent.click(within(aliceRow!).getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: 'Export selected CSV' }));
      expect(await screen.findByText('export failed')).toBeInTheDocument();
    });

    it('clears the selection via the bulk bar clear control', async () => {
      renderPage();
      const rows = screen.getAllByRole('row');
      const aliceRow = rows.find((r) => within(r).queryByText('Alice Seeker'));
      await userEvent.click(within(aliceRow!).getByRole('checkbox'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      await userEvent.click(screen.getByText('Clear selection'));
      expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    });

    it('offers "select all matching" when the whole page is selected and more rows exist', async () => {
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({ totalMatching: 5 }),
        isLoading: false,
        isError: false,
      });
      // The "select all matching" banner triggers one batched fetch
      // (`onSelectAllMatching` -> `dashboardService.dashboard`) for every
      // matching row, independent of what's on the current page.
      const allFiveItems = Array.from({ length: 5 }, (_, i) =>
        rawItem({ profile_item_id: `all-${i}`, name: `Matching ${i}` }),
      );
      mockDashboardServiceDashboard.mockResolvedValueOnce(
        dashboardPageFixture({ items: allFiveItems, totalMatching: 5 }),
      );
      renderPage();
      const headerCheckbox = screen.getByLabelText('Select all rows on this page');
      await userEvent.click(headerCheckbox);
      expect(screen.getByText('All 2 on this page are selected.')).toBeInTheDocument();

      const selectAllBtn = screen.getByRole('button', { name: 'Select all 5 matching' });
      await userEvent.click(selectAllBtn);
      expect(await screen.findByText('All 5 matching are selected.')).toBeInTheDocument();
      expect(mockDashboardServiceDashboard).toHaveBeenCalled();
    });
  });

  // #627: the "select all N matching" batched fetch sizes its `limit` from
  // `total_matching`, which is now the lifecycle-narrowed count. It must forward
  // the active lifecycle too — otherwise it pulls N *unfiltered* rows and the
  // client-side lifecycle filter drops almost all of them, so the operator
  // selects nearly nothing. These guard that fetch stays in sync with the list.
  describe('#627 — lifecycle-aware "select all matching"', () => {
    it('forwards the active lifecycle filter to the batched select-all fetch', async () => {
      nav.resetSearchParams('lifecycle=draft');
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({ totalMatching: 5 }),
        isLoading: false,
        isError: false,
      });
      // The batched fetch returns the full draft set (5 rows). They must be
      // `draft` so they survive the client-side filter the fetch feeds into.
      const draftItems = Array.from({ length: 5 }, (_, i) =>
        rawItem({
          profile_item_id: `draft-${i}`,
          name: `Draft ${i}`,
          lifecycle_status: 'draft',
          profile_status: 'new',
          profile_completion_pct: 40,
        }),
      );
      mockDashboardServiceDashboard.mockResolvedValueOnce(
        dashboardPageFixture({ items: draftItems, totalMatching: 5 }),
      );
      renderPage();

      // Only the draft row is visible under the filter (Alice is live).
      expect(screen.queryByText('Alice Seeker')).not.toBeInTheDocument();
      expect(screen.getByText('Bob Draft')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('Select all rows on this page'));
      await userEvent.click(screen.getByRole('button', { name: 'Select all 5 matching' }));

      await waitFor(() =>
        expect(mockDashboardServiceDashboard).toHaveBeenCalledWith(
          expect.objectContaining({ domain: 'seeker', limit: 5, lifecycle: 'draft' }),
        ),
      );
      expect(await screen.findByText('All 5 matching are selected.')).toBeInTheDocument();
    });

    it('omits lifecycle from the select-all fetch when the filter is "all"', async () => {
      mockUseDashboard.mockReturnValue({
        data: dashboardPageFixture({ totalMatching: 5 }),
        isLoading: false,
        isError: false,
      });
      mockDashboardServiceDashboard.mockResolvedValueOnce(
        dashboardPageFixture({ totalMatching: 5 }),
      );
      renderPage();

      await userEvent.click(screen.getByLabelText('Select all rows on this page'));
      await userEvent.click(screen.getByRole('button', { name: 'Select all 5 matching' }));

      await waitFor(() => expect(mockDashboardServiceDashboard).toHaveBeenCalled());
      const arg = mockDashboardServiceDashboard.mock.calls.at(-1)?.[0];
      expect(arg).toMatchObject({ domain: 'seeker', limit: 5 });
      expect(arg).not.toHaveProperty('lifecycle');
    });
  });
});
