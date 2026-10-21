import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  Role,
  RoleAssignment,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { RolesPanel } from '@/components/console/RolesPanel';

const userId = '00000000-0000-4000-8000-0000000000c1';
const orgId = '00000000-0000-4000-8000-00000000000a';

const role = (key: string, name: string, maxDays: number | null = null): Role => ({
  key,
  name,
  description: '',
  is_builtin: true,
  account_type: 'coordinator',
  base_for: key === 'coordinator' ? 'org_member' : null,
  assignable_org_types: ['aggregator'],
  assigned_by: key === 'coordinator' ? null : 'org.manage',
  max_days: maxDays,
  permissions: [],
});
const ROLES = [
  role('coordinator', 'Coordinator'),
  role('pii_access', 'PII Access', 90),
  role('data_export', 'Data Export'),
];

const live = (key: string, expires: string | null): RoleAssignment => ({
  id: `a-${key}`,
  role_key: key,
  org_id: orgId,
  granted_by: null,
  granted_at: '2026-10-01T00:00:00Z',
  expires_at: expires,
  revoked_at: null,
  live: true,
});

const initial = (additional: RoleAssignment[] = []): UserRolesResponse => ({
  base: [{ role_key: 'coordinator', org_id: orgId }],
  additional,
  assignable: [
    { role_key: 'data_export', org_id: orgId },
    { role_key: 'pii_access', org_id: orgId },
  ],
});

function renderIt(init: UserRolesResponse) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RolesPanel userId={userId} orgId={orgId} initial={init} roles={ROLES} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<RolesPanel />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('shows the base role and the assignable roles', () => {
    renderIt(initial());
    expect(screen.getByTestId('role-base-coordinator')).toHaveTextContent(
      'Coordinator (from membership)',
    );
    expect(screen.getByTestId('role-pii_access')).toHaveTextContent(messages.console.roles.none);
    expect(screen.getByRole('button', { name: 'Assign for 90 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.console.roles.assign })).toBeInTheDocument();
  });

  it('renders nothing when the user has no role here', () => {
    const { container } = renderIt({ base: [], additional: [], assignable: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('assigns a role and shows its expiry', async () => {
    global.fetch = respond(live('pii_access', '2026-12-30T00:00:00Z'), 200) as never;
    renderIt(initial());
    fireEvent.click(screen.getByRole('button', { name: 'Assign for 90 days' }));
    await waitFor(() =>
      expect(screen.getByTestId('role-pii_access')).toHaveTextContent('Until 2026-12-30'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/role/assign/${userId}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ role_key: 'pii_access', org_id: orgId }),
      }),
    );
  });

  it('revokes a live role', async () => {
    global.fetch = respond({ revoked: true }, 200) as never;
    renderIt(initial([live('data_export', null)]));
    expect(screen.getByTestId('role-data_export')).toHaveTextContent(
      messages.console.roles.no_expiry,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.revoke }));
    await waitFor(() =>
      expect(screen.getByTestId('role-data_export')).toHaveTextContent(messages.console.roles.none),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/role/revoke/${userId}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('explains a refused assignment', async () => {
    global.fetch = respond(
      { error: { code: 'ROLE_ASSIGNMENT_NOT_ALLOWED', fields: { reason: 'account_type' } } },
      409,
    ) as never;
    renderIt(initial());
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.assign }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        messages.console.errors.role_not_allowed,
      ),
    );
  });

  it('shows a live role the caller cannot revoke without a revoke button', () => {
    renderIt({ ...initial([live('pii_access', null)]), assignable: [] });
    expect(screen.getByTestId('role-pii_access')).toHaveTextContent(
      messages.console.roles.no_expiry,
    );
    expect(screen.queryByRole('button', { name: messages.console.roles.revoke })).toBeNull();
  });
});
