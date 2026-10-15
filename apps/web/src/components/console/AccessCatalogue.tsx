/**
 * The network admin's read-only view of the access on the network (#871):
 * every role and what it grants, and every permission and which roles grant
 * it. The rows come from `GET /v1/rbac/roles` and `GET /v1/rbac/permissions`,
 * which read the catalogue the API enforces. Nothing here changes a role.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { cn } from '../../lib/cn';

const th = 'text-left font-semibold text-ink-700 px-3 py-2 whitespace-nowrap';
const td = 'px-3 py-2 align-top';

/** Keys rendered as code, one per line. */
function KeyList({ keys, empty }: { keys: string[]; empty: string }) {
  if (keys.length === 0) return <span className="text-ink-500">{empty}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {keys.map((k) => (
        <li key={k}>
          <code className="text-[12.5px]">{k}</code>
        </li>
      ))}
    </ul>
  );
}

/**
 * Links between the roles and the permissions tables.
 *
 * @param current - The table on show.
 */
export function AccessTabs({ current }: { current: 'roles' | 'permissions' }) {
  const t = useTranslations('console.access');
  const tabs = [
    { key: 'roles', href: '/console/access/roles', label: t('tab_roles') },
    { key: 'permissions', href: '/console/access/permissions', label: t('tab_permissions') },
  ] as const;
  return (
    <nav aria-label={t('title')} className="flex gap-2">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            'rounded-[8px] px-3 py-1.5 text-[13.5px]',
            tab.key === current
              ? 'bg-(--bd-primary-50) text-primary-600 font-semibold'
              : 'text-ink-700 hover:bg-ink-50',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Every role, one row each: who holds it, where, how it is given, its longest
 * validity and the permissions it grants.
 *
 * @param roles - The rows from `GET /v1/rbac/roles`.
 */
export function RolesCatalogueTable({ roles }: { roles: CatalogueRole[] }) {
  const t = useTranslations('console.access');
  if (roles.length === 0) return <p className="text-[13.5px] text-ink-600">{t('roles_empty')}</p>;
  const given = (g: CatalogueRole['granted']) =>
    g.via === 'membership'
      ? t(`given_${g.membership}`)
      : t('given_assigned', { permission: g.assigned_by });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead>
          <tr>
            <th className={th}>{t('col_role')}</th>
            <th className={th}>{t('col_description')}</th>
            <th className={th}>{t('col_kind')}</th>
            <th className={th}>{t('col_held_by')}</th>
            <th className={th}>{t('col_held_in')}</th>
            <th className={th}>{t('col_given')}</th>
            <th className={th}>{t('col_max_days')}</th>
            <th className={th}>{t('col_permissions')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.key} data-testid={`role-${r.key}`} className="border-t border-(--bd-border)">
              <td className={td}>
                <p className="font-semibold text-ink-900">{r.name}</p>
                <code className="text-[12.5px] text-ink-600">{r.key}</code>
              </td>
              <td className={td}>{r.description}</td>
              <td className={td}>{r.is_builtin ? t('builtin') : t('custom')}</td>
              <td className={td}>{t(`held_by_${r.held_by}`)}</td>
              <td className={td}>{r.held_in.map((o) => t(`org_${o}`)).join(', ')}</td>
              <td className={td}>{given(r.granted)}</td>
              <td className={td}>
                {r.max_days === null ? t('no_limit') : t('days', { count: r.max_days })}
              </td>
              <td className={td}>
                <KeyList keys={r.permissions} empty={t('none')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every permission, one row each: what it allows, whether it exposes personal
 * data or is retired, and the roles that grant it.
 *
 * @param permissions - The rows from `GET /v1/rbac/permissions`.
 */
export function PermissionsCatalogueTable({ permissions }: { permissions: CataloguePermission[] }) {
  const t = useTranslations('console.access');
  if (permissions.length === 0) {
    return <p className="text-[13.5px] text-ink-600">{t('permissions_empty')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead>
          <tr>
            <th className={th}>{t('col_permission')}</th>
            <th className={th}>{t('col_description')}</th>
            <th className={th}>{t('col_resource')}</th>
            <th className={th}>{t('col_action')}</th>
            <th className={th}>{t('col_personal_data')}</th>
            <th className={th}>{t('col_status')}</th>
            <th className={th}>{t('col_granted_by')}</th>
          </tr>
        </thead>
        <tbody>
          {permissions.map((p) => (
            <tr
              key={p.key}
              data-testid={`permission-${p.key}`}
              className={cn('border-t border-(--bd-border)', p.retired && 'text-ink-500')}
            >
              <td className={td}>
                <code className="text-[12.5px]">{p.key}</code>
              </td>
              <td className={td}>{p.description}</td>
              <td className={td}>{p.resource}</td>
              <td className={td}>{p.action}</td>
              <td className={td}>{p.personal_data ? t('yes') : t('no')}</td>
              <td className={td}>{p.retired ? t('retired') : t('active')}</td>
              <td className={td}>
                <KeyList keys={p.granted_by_roles} empty={t('none')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
