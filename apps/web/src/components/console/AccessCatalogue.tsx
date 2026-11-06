'use client';

/**
 * The network admin's read-only view of the access on the network: every role
 * and what it grants, every permission and which roles grant it, and a matrix
 * of both. The rows come from `GET /v1/rbac/roles` and `GET /v1/rbac/permissions`,
 * which read the catalogue the API enforces. Nothing here changes a role.
 *
 * Summary tiles open a tab or filter to permissions that expose personal data.
 * A search box narrows every tab, and permission and role chips link the tabs.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { AccessSummary } from './access/AccessSummary';
import { AccessToolbar } from './access/AccessToolbar';
import { matches, type AccessTab } from './access/catalogue-filters';
import { MatrixView } from './access/MatrixView';
import { PermissionsView } from './access/PermissionsView';
import { RolesView } from './access/RolesView';

export type { AccessTab } from './access/catalogue-filters';

/** Holds the tab, search, filter and selection state and renders the open tab. */
export function AccessCatalogue({
  tab,
  roles,
  permissions,
}: Readonly<{
  tab: AccessTab;
  roles: CatalogueRole[];
  permissions: CataloguePermission[];
}>) {
  const t = useTranslations('console.access');
  const [view, setView] = useState<AccessTab>(tab);
  const [query, setQuery] = useState('');
  const [personalOnly, setPersonalOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(roles[0]?.key ?? null);
  const [highlight, setHighlight] = useState<string | null>(null);

  const live = permissions.filter((p) => !p.retired);
  const personal = useMemo(
    () => new Set(permissions.filter((p) => p.personal_data).map((p) => p.key)),
    [permissions],
  );
  const q = query.trim().toLowerCase();
  const roleShown = (r: CatalogueRole) =>
    matches(q, r.name, r.key, r.description, ...r.permissions) &&
    (!personalOnly || r.permissions.some((p) => personal.has(p)));
  const permissionShown = (p: CataloguePermission) =>
    (!personalOnly || p.personal_data) &&
    matches(
      q,
      p.key,
      p.description,
      ...p.granted_by_roles.map((k) => roles.find((r) => r.key === k)?.name ?? k),
    );

  // Matrix columns narrow only when the search names a role; a search for a
  // permission keeps every role so its row still shows who grants it.
  const namedRoles = q ? roles.filter((r) => matches(q, r.name, r.key)) : [];
  const matrixRoles = namedRoles.length > 0 ? namedRoles : roles;

  function openRole(key: string) {
    setQuery('');
    setSelected(key);
    setView('roles');
  }

  function openPermission(key: string) {
    setQuery('');
    setPersonalOnly(false);
    setHighlight(key);
    setView('permissions');
  }

  function openTab(next: AccessTab) {
    setPersonalOnly(false);
    setView(next);
  }

  const subtitles: Record<AccessTab, string> = {
    roles: t('subtitle_roles'),
    permissions: t('subtitle_permissions'),
    matrix: t('subtitle_matrix'),
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="-mt-3 text-[14px] text-ink-500">{subtitles[view]}</p>

      <AccessSummary
        roles={roles}
        live={live}
        view={view}
        personalOnly={personalOnly}
        onOpen={openTab}
        onTogglePersonal={() => setPersonalOnly((v) => !v)}
      />

      <AccessToolbar
        view={view}
        roleCount={roles.length}
        permissionCount={live.length}
        personalOnly={personalOnly}
        query={query}
        onView={setView}
        onTogglePersonal={() => setPersonalOnly((v) => !v)}
        onQuery={(next) => {
          setQuery(next);
          setHighlight(null);
        }}
      />

      <p className="-mt-2 text-[12.5px] text-ink-500">{t('hint')}</p>

      {view === 'roles' ? (
        <RolesView
          roles={roles}
          permissions={permissions}
          personal={personal}
          shown={roleShown}
          selected={selected}
          onSelect={setSelected}
          onPermission={openPermission}
          query={query}
        />
      ) : null}
      {view === 'permissions' ? (
        <PermissionsView
          roles={roles}
          rows={permissions.filter(permissionShown)}
          highlight={highlight}
          onRole={openRole}
        />
      ) : null}
      {view === 'matrix' ? (
        <MatrixView roles={matrixRoles} rows={live.filter(permissionShown)} />
      ) : null}
    </div>
  );
}
