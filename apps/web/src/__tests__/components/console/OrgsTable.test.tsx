/**
 * Unit tests for OrgsTable.
 *
 * Covers: the empty state, row rendering (link, status, counts), approving a
 * pending org, the 409 ALREADY_DECIDED in-place update, a generic decision
 * error, and repairing an active org's owner access.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { OrgsTable } from '@/components/console/OrgsTable';

type OrgRow = OrgSearchResponse['orgs'][number];

const pendingOrg: OrgRow = {
  id: '00000000-0000-4000-8000-0000000000b1',
  slug: 'pending-org',
  name: 'Pending Org',
  org_type: 'aggregator',
  status: 'pending',
  is_default: false,
  url: null,
  locations: [],
  legal_name: null,
  gst_number: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  coordinator_count: 3,
  pending_count: 1,
};

const activeOrg: OrgRow = {
  ...pendingOrg,
  id: '00000000-0000-4000-8000-0000000000b2',
  name: 'Active Org',
  status: 'active',
};

function renderTable(orgs: OrgRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OrgsTable orgs={orgs} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<OrgsTable />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('renders the empty message with no rows', () => {
    renderTable([]);
    expect(screen.getByText(messages.console.orgs.empty)).toBeInTheDocument();
  });

  it('renders a row with its link, status and counts', () => {
    renderTable([pendingOrg]);
    const link = screen.getByRole('link', { name: 'Pending Org' });
    expect(link).toHaveAttribute('href', `/console/orgs/${pendingOrg.id}`);
    expect(screen.getByText(messages.console.status.pending)).toBeInTheDocument();
    expect(screen.getByText(/3 coordinators/)).toBeInTheDocument();
  });

  it('shows approve/reject for a pending org, and no other row action', () => {
    renderTable([pendingOrg, activeOrg]);
    expect(screen.getAllByRole('button', { name: messages.console.orgs.approve })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: messages.console.orgs.reject })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: messages.console.orgs.repair })).toBeNull();
  });

  it('drops the actions column when nothing is pending', () => {
    renderTable([activeOrg]);
    expect(screen.queryByText(messages.console.orgs.col_actions)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('approves a pending org and updates its status in place', async () => {
    global.fetch = respond(
      { id: pendingOrg.id, status: 'active', notified: true, owner_access: 'granted' },
      200,
    ) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.approve }));
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.decided)).toBeInTheDocument(),
    );
    expect(screen.getByText(messages.console.status.active)).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/decision/${pendingOrg.id}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    );
  });

  it('updates the row when the decision was already made elsewhere (C10)', async () => {
    global.fetch = respond(
      { error: { code: 'ALREADY_DECIDED', fields: { status: 'inactive' } } },
      409,
    ) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.reject }));
    await waitFor(() =>
      expect(screen.getByText(messages.console.status.inactive)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: messages.console.orgs.approve })).toBeNull();
  });

  it('shows a generic error when a decision fails', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderTable([pendingOrg]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.approve }));
    expect(await screen.findByText(messages.console.errors.generic)).toBeInTheDocument();
  });
});
