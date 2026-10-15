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

/** A small coloured label (built-in, personal data, retired). */
function Tag({
  tone,
  children,
}: {
  tone: 'brand' | 'neutral' | 'warn' | 'muted';
  children: string;
}) {
  const tones = {
    brand: 'bg-(--bd-primary-50) text-primary-600',
    neutral: 'bg-ink-50 text-ink-700',
    warn: 'bg-rose-50 text-rose-700',
    muted: 'bg-ink-50 text-ink-500',
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Keys as small code chips that wrap within their cell. */
function KeyList({ keys, empty }: { keys: string[]; empty: string }) {
  if (keys.length === 0) return <span className="text-ink-500">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {keys.map((k) => (
        <li key={k}>
          <code className="inline-block rounded-md bg-ink-50 px-1.5 py-0.5 text-[11.5px] text-ink-700">
            {k}
          </code>
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
    <nav aria-label={t('title')} className="inline-flex gap-1 rounded-[12px] bg-ink-50 p-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            'rounded-[9px] px-3.5 py-1.5 text-[13px] font-medium transition-colors',
            tab.key === current
              ? 'bg-(--bd-card) text-primary-600 font-semibold bd-shadow'
              : 'text-ink-500 hover:text-ink-900',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Every role, one row each: what it is for (with its longest validity, where
 * one applies), who holds it and where, and the permissions it grants.
 *
 * @param roles - The rows from `GET /v1/rbac/roles`.
 */
export function RolesCatalogueTable({ roles }: { roles: CatalogueRole[] }) {
  const t = useTranslations('console.access');
  if (roles.length === 0) {
    return <p className="px-5 py-8 text-center text-[13.5px] text-ink-500">{t('roles_empty')}</p>;
  }
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="bd-table">
        <thead>
          <tr>
            <th>{t('col_role')}</th>
            <th>{t('col_description')}</th>
            <th>{t('col_kind')}</th>
            <th>{t('col_held_by')}</th>
            <th>{t('col_permissions')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.key} data-testid={`role-${r.key}`}>
              <td className="bd-top">
                <p className="font-semibold text-ink-900">{r.name}</p>
                <code className="text-[12px] text-ink-500">{r.key}</code>
              </td>
              <td className="bd-wrap bd-top text-ink-600" style={{ maxWidth: 320 }}>
                {r.description ? <p>{r.description}</p> : null}
                {r.max_days !== null ? (
                  <p className="mt-1 text-[12.5px] font-medium text-amber-700">
                    {t('valid_for', { count: r.max_days })}
                  </p>
                ) : null}
              </td>
              <td className="bd-top">
                <Tag tone={r.is_builtin ? 'brand' : 'neutral'}>
                  {r.is_builtin ? t('builtin') : t('custom')}
                </Tag>
              </td>
              <td className="bd-top">
                <p>{t(`held_by_${r.held_by}`)}</p>
                <p className="text-[12.5px] text-ink-500">
                  {t('held_in_line', { orgs: r.held_in.map((o) => t(`org_${o}`)).join(', ') })}
                </p>
              </td>
              <td className="bd-wrap bd-top" style={{ minWidth: 280 }}>
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
 * data, and the roles that grant it. A retired permission is tagged.
 *
 * @param permissions - The rows from `GET /v1/rbac/permissions`.
 */
export function PermissionsCatalogueTable({ permissions }: { permissions: CataloguePermission[] }) {
  const t = useTranslations('console.access');
  if (permissions.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-[13.5px] text-ink-500">{t('permissions_empty')}</p>
    );
  }
  return (
    <div className="overflow-x-auto scroll-x">
      <table className="bd-table">
        <thead>
          <tr>
            <th>{t('col_permission')}</th>
            <th>{t('col_description')}</th>
            <th>{t('col_personal_data')}</th>
            <th>{t('col_granted_by')}</th>
          </tr>
        </thead>
        <tbody>
          {permissions.map((p) => (
            <tr
              key={p.key}
              data-testid={`permission-${p.key}`}
              className={cn(p.retired && 'opacity-60')}
            >
              <td className="bd-top">
                <span className="inline-flex items-center gap-2">
                  <code className="text-[12.5px] font-semibold text-ink-900">{p.key}</code>
                  {p.retired ? <Tag tone="muted">{t('retired')}</Tag> : null}
                </span>
              </td>
              <td className="bd-wrap bd-top text-ink-600">{p.description}</td>
              <td className="bd-top">
                {p.personal_data ? (
                  <Tag tone="warn">{t('yes')}</Tag>
                ) : (
                  <span className="text-ink-500">{t('no')}</span>
                )}
              </td>
              <td className="bd-wrap bd-top">
                <KeyList keys={p.granted_by_roles} empty={t('none')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
