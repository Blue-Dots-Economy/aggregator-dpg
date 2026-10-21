import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { AccessCatalogue, AccessTabs, type AccessTab } from '@/components/console/AccessCatalogue';

const ROLES: CatalogueRole[] = [
  {
    key: 'network_admin',
    name: 'Network Admin',
    description: "The root organisation's owner; administers the network.",
    is_builtin: true,
    held_by: 'org_owners',
    held_in: ['network_facilitator'],
    granted: { via: 'membership', membership: 'root_owner' },
    max_days: null,
    permissions: ['network.administer', 'org.manage'],
  },
  {
    key: 'pii_access',
    name: 'PII Access',
    description: 'Sees and exports decrypted profile details.',
    is_builtin: true,
    held_by: 'coordinators',
    held_in: ['aggregator'],
    granted: { via: 'assignment', assigned_by: 'org.manage' },
    max_days: 90,
    permissions: ['profiles.view_pii'],
  },
  {
    key: 'verifier',
    name: 'Verifier',
    description: '',
    is_builtin: false,
    held_by: 'coordinators',
    held_in: ['aggregator'],
    granted: { via: 'assignment', assigned_by: 'org.manage' },
    max_days: 1,
    permissions: [],
  },
];

const PERMISSIONS: CataloguePermission[] = [
  {
    key: 'agreement.manage',
    description: 'Create and link agreements (terms, privacy, consent)',
    resource: 'agreements',
    action: 'manage',
    personal_data: false,
    retired: true,
    granted_by_roles: [],
  },
  {
    key: 'profiles.view_pii',
    description: 'See and export decrypted details',
    resource: 'profiles',
    action: 'view_pii',
    personal_data: true,
    retired: false,
    granted_by_roles: ['pii_access'],
  },
];

const withIntl = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const show = (tab: AccessTab) =>
  withIntl(<AccessCatalogue tab={tab} roles={ROLES} permissions={PERMISSIONS} />);

/** The cards or rows under a group heading. */
const group = (title: string) =>
  within(screen.getByRole('heading', { name: title }).closest('section') as HTMLElement);

/** The visible text of each cell of a table row. */
const cells = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('cell')
    .map((c) => c.textContent);

const search = (text: string) =>
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });

describe('<AccessCatalogue /> summary', () => {
  it('counts roles, live permissions (noting retired ones), personal data and custom roles', () => {
    show('roles');
    const tile = (label: string) =>
      within(screen.getByTestId('access-summary')).getByText(label).closest('.bd-card')
        ?.textContent;
    expect(tile('Roles')).toBe('3Roles');
    expect(tile('Permissions')).toBe('1Permissions · 1 retired');
    expect(tile('Expose personal data')).toBe('1Expose personal data');
    expect(tile('Custom roles')).toBe('1Custom roles');
  });
});

describe('<AccessCatalogue /> roles', () => {
  it('groups built-in roles by how they are held, and custom roles apart', () => {
    show('roles');
    expect(group('From membership').getByTestId('role-network_admin')).toBeInTheDocument();
    expect(group('Assigned').getByTestId('role-pii_access')).toBeInTheDocument();
    expect(group('Assigned').queryByTestId('role-verifier')).toBeNull();
    expect(group('Custom roles').getByTestId('role-verifier')).toBeInTheDocument();
  });

  it('shows who holds a role, where, its validity, and links its permissions', () => {
    show('roles');
    const card = within(screen.getByTestId('role-pii_access'));
    expect(card.getByText('Sees and exports decrypted profile details.')).toBeInTheDocument();
    expect(card.getByText('Coordinators · Aggregator organisations')).toBeInTheDocument();
    expect(card.getByText('Valid for up to 90 days')).toBeInTheDocument();
    expect(card.getByText('1 permission')).toBeInTheDocument();
    const chip = card.getByRole('link', { name: 'profiles.view_pii' });
    expect(chip).toHaveAttribute(
      'href',
      '/console/access/permissions#permission-profiles.view_pii',
    );
    expect(chip).toHaveAttribute('title', 'Personal data');
  });

  it('marks a custom role, a one-day validity and a role granting nothing', () => {
    show('roles');
    const card = within(screen.getByTestId('role-verifier'));
    expect(card.getByText('Valid for up to 1 day')).toBeInTheDocument();
    expect(card.getByText('No permissions')).toBeInTheDocument();
    const admin = within(screen.getByTestId('role-network_admin'));
    expect(admin.queryByText(/Valid for/)).toBeNull();
    expect(admin.getByRole('link', { name: 'org.manage' })).not.toHaveAttribute('title');
  });

  it('narrows the roles by name, key, description or permission', () => {
    show('roles');
    search('view_pii');
    expect(screen.getByTestId('role-pii_access')).toBeInTheDocument();
    expect(screen.queryByTestId('role-network_admin')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'From membership' })).toBeNull();
    search('nothing-like-this');
    expect(screen.getByText('Nothing matches “nothing-like-this”.')).toBeInTheDocument();
  });

  it('has no controls to create, edit, delete or assign', () => {
    show('roles');
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  });

  it('says so when there are no roles', () => {
    withIntl(<AccessCatalogue tab="roles" roles={[]} permissions={PERMISSIONS} />);
    expect(screen.getByText('No roles.')).toBeInTheDocument();
  });
});

describe('<AccessCatalogue /> permissions', () => {
  it('lists each permission in a table with its personal-data flag and granting roles', () => {
    show('permissions');
    expect(cells('permission-profiles.view_pii')).toEqual([
      'profiles.view_pii',
      'See and export decrypted details',
      'Yes',
      'PII Access',
    ]);
    expect(
      within(screen.getByTestId('permission-profiles.view_pii')).getByRole('link', {
        name: 'PII Access',
      }),
    ).toHaveAttribute('href', '/console/access/roles#role-pii_access');
  });

  it('tags a retired permission, and says when no role grants it', () => {
    show('permissions');
    expect(cells('permission-agreement.manage')).toEqual([
      'agreement.manageRetired',
      'Create and link agreements (terms, privacy, consent)',
      'No',
      'No role grants it',
    ]);
    expect(cells('permission-profiles.view_pii')[0]).not.toMatch(/Retired/);
  });

  it('narrows the permissions by key, description or role name', () => {
    show('permissions');
    search('pii access');
    expect(screen.getByTestId('permission-profiles.view_pii')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-agreement.manage')).toBeNull();
  });

  it('says so when there are no permissions', () => {
    withIntl(<AccessCatalogue tab="permissions" roles={ROLES} permissions={[]} />);
    expect(screen.getByText('No permissions.')).toBeInTheDocument();
  });
});

describe('<AccessCatalogue /> links between the tabs', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('marks and scrolls to the card or row the link points at', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#permission-profiles.view_pii';
    show('permissions');
    expect(screen.getByTestId('permission-profiles.view_pii')).toHaveClass('bd-anchor-on');
    expect(screen.getByTestId('permission-agreement.manage')).not.toHaveClass('bd-anchor-on');
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('marks nothing without a hash', () => {
    show('roles');
    expect(document.querySelector('.bd-anchor-on')).toBeNull();
  });
});

describe('<AccessTabs />', () => {
  it('links both lists and marks the one on show', () => {
    withIntl(<AccessTabs current="permissions" />);
    const roles = screen.getByRole('link', { name: 'Roles' });
    const permissions = screen.getByRole('link', { name: 'Permissions' });
    expect(roles).toHaveAttribute('href', '/console/access/roles');
    expect(roles).not.toHaveAttribute('aria-current');
    expect(permissions).toHaveAttribute('href', '/console/access/permissions');
    expect(permissions).toHaveAttribute('aria-current', 'page');
  });
});
