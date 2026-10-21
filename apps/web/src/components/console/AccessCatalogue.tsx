'use client';

/**
 * The network admin's read-only view of the access on the network (#871):
 * every role and what it grants, and every permission and which roles grant
 * it. The rows come from `GET /v1/rbac/roles` and `GET /v1/rbac/permissions`,
 * which read the catalogue the API enforces. Nothing here changes a role.
 *
 * Roles are cards, grouped by how they are held (membership or assignment);
 * permissions are grouped by the area they apply to. A search box narrows
 * either list, and chips link a role to its permissions and back.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { I, type IconName } from '../../icons';
import { cn } from '../../lib/cn';

/** Which list is on show. */
export type AccessTab = 'roles' | 'permissions';

const ROLES_HREF = '/console/access/roles';
const PERMISSIONS_HREF = '/console/access/permissions';

/** Anchor id of a role card / permission row, for the cross-links. */
const roleAnchor = (key: string) => `role-${key}`;
const permissionAnchor = (key: string) => `permission-${key}`;

/** Lower-cased substring match; an empty query matches everything. */
const matches = (query: string, ...fields: string[]) =>
  !query || fields.some((f) => f.toLowerCase().includes(query));

/** A small coloured label (personal data, retired). */
function Tag({ tone, children }: { tone: 'warn' | 'muted'; children: string }) {
  const tones = {
    warn: 'bg-rose-500/10 text-rose-600',
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

/** A chip linking to a role or a permission on the other tab. */
function Chip({
  href,
  danger = false,
  mono = false,
  title,
  children,
}: {
  href: string;
  danger?: boolean;
  mono?: boolean;
  title?: string;
  children: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors',
        mono && 'font-mono',
        danger
          ? 'bg-rose-500/10 text-rose-600 hover:bg-rose-500/20'
          : 'bg-ink-50 text-ink-700 hover:bg-(--bd-primary-50) hover:text-primary-600',
      )}
    >
      {danger ? <span className="w-1.5 h-1.5 rounded-full bg-rose-500" aria-hidden /> : null}
      {children}
    </Link>
  );
}

/** One summary tile, styled like the coordinator dashboard's. */
function Stat({
  icon,
  value,
  label,
  hint,
  tone,
}: {
  icon: IconName;
  value: number;
  label: string;
  hint?: string;
  tone: 'brand' | 'warn' | 'neutral';
}) {
  const Ic = I[icon];
  const tones = {
    brand: 'bg-(--bd-primary-50) text-primary-600',
    warn: 'bg-rose-500/10 text-rose-600',
    neutral: 'bg-ink-50 text-ink-500',
  } as const;
  return (
    <div className="bd-card bd-shadow p-4 flex items-center gap-3.5">
      <div
        className={cn(
          'w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0',
          tones[tone],
        )}
      >
        <Ic size={18} />
      </div>
      <div className="min-w-0">
        <div className="font-display font-bold text-[24px] leading-none text-ink-900">{value}</div>
        <div className="text-[12.5px] text-ink-500 mt-1">
          {label}
          {hint ? <span className="text-ink-400"> · {hint}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** A labelled group of cards or rows. */
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-(--bd-fg-muted)">
          {title}
        </h2>
        {hint ? <p className="text-[12.5px] text-ink-500 mt-0.5">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The "nothing matches" line. */
function NoMatch({ text }: { text: string }) {
  return <p className="bd-card px-5 py-8 text-center text-[13.5px] text-ink-500">{text}</p>;
}

/**
 * Links between the roles and the permissions lists.
 *
 * @param props.current - The list on show.
 */
export function AccessTabs({ current }: { current: AccessTab }) {
  const t = useTranslations('console.access');
  const tabs = [
    { key: 'roles', href: ROLES_HREF, label: t('tab_roles') },
    { key: 'permissions', href: PERMISSIONS_HREF, label: t('tab_permissions') },
  ] as const;
  return (
    <nav
      aria-label={t('title')}
      className="inline-flex gap-1 rounded-[12px] bg-ink-50 p-1 self-start"
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? 'page' : undefined}
          className={cn(
            'rounded-[9px] px-4 py-1.5 text-[13px] font-medium transition-colors',
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
 * The roles and permissions view: summary tiles, the tab switch with a search
 * box, then the list for the tab.
 *
 * @param props.tab - The list on show.
 * @param props.roles - The rows from `GET /v1/rbac/roles`.
 * @param props.permissions - The rows from `GET /v1/rbac/permissions`.
 */
export function AccessCatalogue({
  tab,
  roles,
  permissions,
}: {
  tab: AccessTab;
  roles: CatalogueRole[];
  permissions: CataloguePermission[];
}) {
  const t = useTranslations('console.access');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // The card or row a chip on the other tab linked to (`#role-…` /
  // `#permission-…`). Client-side navigation does not update CSS `:target`,
  // so the hash is read here and the match is marked and scrolled to.
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    setTarget(id);
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, []);

  const personal = useMemo(
    () => new Set(permissions.filter((p) => p.personal_data).map((p) => p.key)),
    [permissions],
  );
  const live = permissions.filter((p) => !p.retired);
  const retired = permissions.length - live.length;
  const placeholder = tab === 'roles' ? t('search_roles') : t('search_permissions');

  return (
    <div className="flex flex-col gap-6">
      <div data-testid="access-summary" className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat icon="shield" tone="brand" value={roles.length} label={t('stat_roles')} />
        <Stat
          icon="lock"
          tone="brand"
          value={live.length}
          label={t('stat_permissions')}
          {...(retired > 0 ? { hint: t('stat_retired', { count: retired }) } : {})}
        />
        <Stat
          icon="alert"
          tone="warn"
          value={live.filter((p) => p.personal_data).length}
          label={t('stat_personal_data')}
        />
        <Stat
          icon="spark"
          tone="neutral"
          value={roles.filter((r) => !r.is_builtin).length}
          label={t('stat_custom')}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <AccessTabs current={tab} />
        <label className="relative sm:w-[320px]">
          <span className="sr-only">{placeholder}</span>
          <I.search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none"
          />
          <input
            type="search"
            className="bd-input bd-input--icon-left"
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {tab === 'roles' ? (
        <RolesView
          roles={roles}
          personal={personal}
          query={q}
          rawQuery={query.trim()}
          target={target}
        />
      ) : (
        <PermissionsView
          permissions={permissions}
          roles={roles}
          query={q}
          rawQuery={query.trim()}
          target={target}
        />
      )}
    </div>
  );
}

/**
 * Every role as a card, grouped into base roles (from membership) and
 * additional roles (assigned).
 */
function RolesView({
  roles,
  personal,
  query,
  rawQuery,
  target,
}: {
  roles: CatalogueRole[];
  personal: ReadonlySet<string>;
  query: string;
  rawQuery: string;
  target: string | null;
}) {
  const t = useTranslations('console.access');
  if (roles.length === 0) return <NoMatch text={t('roles_empty')} />;
  const shown = roles.filter((r) => matches(query, r.name, r.key, r.description, ...r.permissions));
  if (shown.length === 0) return <NoMatch text={t('no_match', { query: rawQuery })} />;
  const groups = [
    {
      title: t('group_membership'),
      hint: t('group_membership_hint'),
      rows: shown.filter((r) => r.is_builtin && r.granted.via === 'membership'),
    },
    {
      title: t('group_assigned'),
      hint: t('group_assigned_hint'),
      rows: shown.filter((r) => r.is_builtin && r.granted.via === 'assignment'),
    },
    {
      title: t('group_custom'),
      hint: t('group_custom_hint'),
      rows: shown.filter((r) => !r.is_builtin),
    },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <Group key={g.title} title={g.title} hint={g.hint}>
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {g.rows.map((r) => (
              <li
                key={r.key}
                id={roleAnchor(r.key)}
                data-testid={`role-${r.key}`}
                className={cn(
                  'bd-card bd-shadow bd-anchor p-4 flex flex-col gap-2.5',
                  target === roleAnchor(r.key) && 'bd-anchor-on',
                )}
              >
                <div className="min-w-0">
                  <h3 className="font-display font-bold text-[15px] text-ink-900">{r.name}</h3>
                  <code className="text-[11.5px] text-ink-500">{r.key}</code>
                </div>
                {r.description ? <p className="text-[13px] text-ink-600">{r.description}</p> : null}
                <div className="flex flex-col gap-1 text-[12.5px] text-ink-600">
                  <span className="inline-flex items-center gap-1.5">
                    {r.held_by === 'coordinators' ? <I.users size={14} /> : <I.user size={14} />}
                    {t('held_line', {
                      holders: t(`held_by_${r.held_by}`),
                      orgs: r.held_in.map((o) => t(`org_${o}`)).join(', '),
                    })}
                  </span>
                  {r.max_days !== null ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
                      <I.calendar size={14} />
                      {t('valid_for', { count: r.max_days })}
                    </span>
                  ) : null}
                </div>
                <div className="pt-2.5 border-t border-(--bd-border-soft)">
                  <div className="text-[11px] uppercase tracking-[0.06em] font-semibold text-(--bd-fg-muted) mb-2">
                    {t('permission_count', { count: r.permissions.length })}
                  </div>
                  {r.permissions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {r.permissions.map((p) => (
                        <Chip
                          key={p}
                          href={`${PERMISSIONS_HREF}#${permissionAnchor(p)}`}
                          danger={personal.has(p)}
                          mono
                          {...(personal.has(p) ? { title: t('personal_data') } : {})}
                        >
                          {p}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Group>
      ))}
      <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-500">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" aria-hidden />
        {t('legend_personal_data')}
      </p>
    </div>
  );
}

/**
 * Every permission in a table: what it allows, whether it exposes personal
 * data, and the roles that grant it. A retired permission is tagged.
 */
function PermissionsView({
  permissions,
  roles,
  query,
  rawQuery,
  target,
}: {
  permissions: CataloguePermission[];
  roles: CatalogueRole[];
  query: string;
  rawQuery: string;
  target: string | null;
}) {
  const t = useTranslations('console.access');
  if (permissions.length === 0) return <NoMatch text={t('permissions_empty')} />;
  const nameOf = new Map(roles.map((r) => [r.key, r.name]));
  const shown = permissions.filter((p) =>
    matches(query, p.key, p.description, ...p.granted_by_roles.map((k) => nameOf.get(k) ?? k)),
  );
  if (shown.length === 0) return <NoMatch text={t('no_match', { query: rawQuery })} />;

  return (
    <div className="bd-card bd-shadow overflow-hidden">
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
            {shown.map((p) => (
              <tr
                key={p.key}
                id={permissionAnchor(p.key)}
                data-testid={`permission-${p.key}`}
                className={cn(
                  'bd-anchor',
                  p.retired && 'opacity-60',
                  target === permissionAnchor(p.key) && 'bd-anchor-on',
                )}
              >
                <td>
                  <span className="inline-flex items-center gap-2">
                    <code className="text-[12.5px] font-semibold text-ink-900">{p.key}</code>
                    {p.retired ? <Tag tone="muted">{t('retired')}</Tag> : null}
                  </span>
                </td>
                <td className="bd-wrap text-ink-600">{p.description}</td>
                <td>
                  {p.personal_data ? (
                    <Tag tone="warn">{t('yes')}</Tag>
                  ) : (
                    <span className="text-ink-500">{t('no')}</span>
                  )}
                </td>
                <td className="bd-wrap">
                  {p.granted_by_roles.length === 0 ? (
                    <span className="text-ink-500">{t('granted_by_none')}</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {p.granted_by_roles.map((k) => (
                        <Chip key={k} href={`${ROLES_HREF}#${roleAnchor(k)}`}>
                          {nameOf.get(k) ?? k}
                        </Chip>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
