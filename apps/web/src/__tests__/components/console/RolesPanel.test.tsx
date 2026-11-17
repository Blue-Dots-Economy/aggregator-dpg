import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  Role,
  RoleAssignment,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { RolesPanel } from '@/components/console/RolesPanel';
import { chooseOption } from '@/__tests__/test-utils';

const userId = '00000000-0000-4000-8000-0000000000c1';
const orgId = '00000000-0000-4000-8000-00000000000a';

/** Permissions per role key, as the API serves them; the base role covers export and PII. */
const PERMISSIONS: Readonly<Record<string, string[]>> = {
  coordinator: [
    'profiles.view',
    'profiles.onboard',
    'campaigns.run',
    'profiles.export',
    'profiles.view_pii',
  ],
  pii_access: ['profiles.view_pii'],
  data_export: ['profiles.export'],
  region_viewer: ['profiles.verify'],
  pii_extra: ['profiles.view_pii', 'profiles.verify'],
  pii_custom: ['profiles.view_pii', 'profiles.verify'],
};

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
  permissions: PERMISSIONS[key] ?? ['profiles.export'],
});
const ROLES = [
  role('coordinator', 'Onboard Seekers & Providers'),
  role('pii_access', 'PII Access', 90),
  role('data_export', 'Data Export'),
  role('region_viewer', 'Region Viewer'),
  role('pii_extra', 'PII Extra', 90),
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
  // Roles the base role does not cover, so they can be assigned.
  assignable: [
    { role_key: 'pii_extra', org_id: orgId },
    { role_key: 'region_viewer', org_id: orgId },
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

  it('shows the base role and the assignable roles', async () => {
    renderIt(initial());
    const base = screen.getByTestId('role-base-coordinator');
    expect(base).toHaveTextContent('Onboard Seekers & Providers');
    expect(base).toHaveTextContent(messages.console.roles.base_tag);
    expect(screen.getByTestId('role-pii_extra')).toHaveTextContent(messages.console.roles.none);
    expect(screen.getByText(messages.console.roles.personal_data)).toBeInTheDocument();
    const duration = screen.getByRole('combobox', { name: 'Duration for PII Extra' });
    expect(duration).toHaveTextContent('90 days');
    fireEvent.click(duration);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['30 days', '60 days', '90 days']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.getAllByRole('button', { name: messages.console.roles.assign })).toHaveLength(2);
  });

  it('renders nothing when the user has no role here', () => {
    const { container } = renderIt({ base: [], additional: [], assignable: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('asks before giving personal-data access, then assigns for the chosen days', async () => {
    global.fetch = respond(live('pii_extra', '2026-12-30T00:00:00Z'), 200) as never;
    renderIt(initial());
    await chooseOption(screen.getByRole('combobox', { name: 'Duration for PII Extra' }), '30 days');
    const [piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(piiAssign!);
    const dialog = screen.getByRole('dialog', { name: 'Give PII Extra?' });
    expect(dialog).toHaveTextContent('This person will see personal data for 30 days.');
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.confirm_pii_yes }));
    await waitFor(() =>
      expect(screen.getByTestId('role-pii_extra')).toHaveTextContent('Until Dec 30, 2026'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/role/assign/${userId}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ role_key: 'pii_extra', org_id: orgId, days: 30 }),
      }),
    );
  });

  it('says a personal-data role without a day limit lasts until removed', () => {
    const roles = [
      ...ROLES,
      {
        ...role('pii_custom', 'PII Custom'),
        permissions: ['profiles.view_pii', 'profiles.verify'],
      },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RolesPanel
          userId={userId}
          orgId={orgId}
          initial={{ ...initial(), assignable: [{ role_key: 'pii_custom', org_id: orgId }] }}
          roles={roles}
          personName="Asha"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.assign }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Asha will see personal data until this role is removed.',
    );
  });

  it('keeps focus inside the confirmation and returns it on close', () => {
    renderIt(initial());
    const [piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    piiAssign!.focus();
    fireEvent.click(piiAssign!);
    const confirm = screen.getByRole('button', { name: messages.console.roles.confirm_pii_yes });
    const cancel = screen.getByRole('button', { name: messages.console.roles.cancel });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(piiAssign).toHaveFocus();
  });

  it('cancels the personal-data confirmation without assigning', () => {
    global.fetch = vi.fn() as never;
    renderIt(initial());
    const [piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(piiAssign!);
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows roles the base role already covers as held, with no expiry and no actions', () => {
    renderIt({
      ...initial([live('pii_access', '2026-12-30T00:00:00Z')]),
      assignable: [
        { role_key: 'data_export', org_id: orgId },
        { role_key: 'pii_access', org_id: orgId },
      ],
    });
    for (const key of ['data_export', 'pii_access']) {
      const row = screen.getByTestId(`role-${key}`);
      expect(row).toHaveTextContent(messages.console.roles.no_expiry);
      // An older time-limited grant does not show its end date: the base role covers it.
      expect(row).not.toHaveTextContent('Until');
    }
    expect(screen.getAllByText(messages.console.roles.assigned)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: messages.console.roles.assign })).toBeNull();
    expect(screen.queryByRole('button', { name: messages.console.roles.revoke })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('revokes a live role the base role does not cover', async () => {
    global.fetch = respond({ revoked: true }, 200) as never;
    renderIt({
      ...initial([live('region_viewer', null)]),
      assignable: [{ role_key: 'region_viewer', org_id: orgId }],
    });
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.revoke }));
    expect(screen.getByRole('dialog', { name: 'Remove Region Viewer?' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: messages.console.roles.revoke,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('role-region_viewer')).toHaveTextContent(
        messages.console.roles.none,
      ),
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
    const [, plainAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(plainAssign!);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        messages.console.errors.role_not_allowed,
      ),
    );
  });

  it('shows a live role the caller cannot revoke without a revoke button', () => {
    renderIt({ ...initial([live('pii_extra', null)]), assignable: [] });
    expect(screen.getByTestId('role-pii_extra')).toHaveTextContent(
      messages.console.roles.no_expiry,
    );
    expect(screen.queryByRole('button', { name: messages.console.roles.revoke })).toBeNull();
  });
});
