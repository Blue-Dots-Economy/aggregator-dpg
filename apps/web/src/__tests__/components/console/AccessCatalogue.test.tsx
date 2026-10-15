import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import {
  AccessTabs,
  PermissionsCatalogueTable,
  RolesCatalogueTable,
} from '@/components/console/AccessCatalogue';

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

/** The visible text of each cell of a row. */
const cells = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('cell')
    .map((c) => c.textContent);

describe('<RolesCatalogueTable />', () => {
  it('shows each role with its description, who holds it, where, and what it grants', () => {
    withIntl(<RolesCatalogueTable roles={ROLES} />);
    expect(cells('role-network_admin')).toEqual([
      'Network Adminnetwork_admin',
      "The root organisation's owner; administers the network.",
      'Built-in',
      'Organisation ownersin The network organisation',
      'network.administerorg.manage',
    ]);
  });

  it('adds the longest validity to the description only where one applies', () => {
    withIntl(<RolesCatalogueTable roles={ROLES} />);
    expect(cells('role-pii_access')).toEqual([
      'PII Accesspii_access',
      'Sees and exports decrypted profile details.Valid for up to 90 days.',
      'Built-in',
      'Coordinatorsin Aggregator organisations',
      'profiles.view_pii',
    ]);
    expect(cells('role-network_admin')[1]).not.toMatch(/Valid for/);
  });

  it('marks a custom role, a one-day validity and a role granting nothing', () => {
    withIntl(<RolesCatalogueTable roles={ROLES} />);
    expect(cells('role-verifier')).toEqual([
      'Verifierverifier',
      'Valid for up to 1 day.',
      'Custom',
      'Coordinatorsin Aggregator organisations',
      'None',
    ]);
  });

  it('has no controls to create, edit, delete or assign', () => {
    withIntl(<RolesCatalogueTable roles={ROLES} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
  });

  it('says so when there are no roles', () => {
    withIntl(<RolesCatalogueTable roles={[]} />);
    expect(screen.getByText('No roles.')).toBeInTheDocument();
  });
});

describe('<PermissionsCatalogueTable />', () => {
  it('shows each permission with its personal-data flag and granting roles', () => {
    withIntl(<PermissionsCatalogueTable permissions={PERMISSIONS} />);
    expect(cells('permission-profiles.view_pii')).toEqual([
      'profiles.view_pii',
      'See and export decrypted details',
      'Yes',
      'pii_access',
    ]);
  });

  it('tags a retired permission, and only that one', () => {
    withIntl(<PermissionsCatalogueTable permissions={PERMISSIONS} />);
    expect(cells('permission-agreement.manage')).toEqual([
      'agreement.manageRetired',
      'Create and link agreements (terms, privacy, consent)',
      'No',
      'None',
    ]);
    expect(cells('permission-profiles.view_pii')[0]).not.toMatch(/Retired/);
  });

  it('has no controls', () => {
    withIntl(<PermissionsCatalogueTable permissions={PERMISSIONS} />);
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });

  it('says so when there are no permissions', () => {
    withIntl(<PermissionsCatalogueTable permissions={[]} />);
    expect(screen.getByText('No permissions.')).toBeInTheDocument();
  });
});

describe('<AccessTabs />', () => {
  it('links both tables and marks the one on show', () => {
    withIntl(<AccessTabs current="permissions" />);
    const roles = screen.getByRole('link', { name: 'Roles' });
    const permissions = screen.getByRole('link', { name: 'Permissions' });
    expect(roles).toHaveAttribute('href', '/console/access/roles');
    expect(roles).not.toHaveAttribute('aria-current');
    expect(permissions).toHaveAttribute('href', '/console/access/permissions');
    expect(permissions).toHaveAttribute('aria-current', 'page');
  });
});
