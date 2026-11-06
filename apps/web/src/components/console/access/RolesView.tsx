/**
 * The roles tab: the role list grouped by where roles are held, beside the
 * selected role's detail.
 */

import { useTranslations } from 'next-intl';
import { Building2, Globe, KeyRound, Shield, type LucideIcon } from 'lucide-react';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { cn } from '@/lib/cn';
import { scopeOf, type Scope } from './catalogue-filters';
import { Badge, Empty } from './CatalogueUi';
import { RoleDetail } from './RoleDetail';

/** The role list grouped by where roles are held, beside the selected role's detail. */
export function RolesView({
  roles,
  permissions,
  personal,
  shown,
  selected,
  onSelect,
  onPermission,
  query,
}: Readonly<{
  roles: CatalogueRole[];
  permissions: CataloguePermission[];
  personal: Set<string>;
  shown: (r: CatalogueRole) => boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onPermission: (key: string) => void;
  query: string;
}>) {
  const t = useTranslations('console.access');
  const visible = roles.filter(shown);
  if (roles.length === 0) return <Empty>{t('roles_empty')}</Empty>;
  const current = visible.find((r) => r.key === selected) ?? visible[0];
  if (current === undefined) return <Empty>{t('no_match', { query })}</Empty>;
  const scopes: Array<{ id: Scope; icon: LucideIcon; title: string; hint: string }> = [
    { id: 'network', icon: Globe, title: t('scope_network'), hint: t('scope_network_hint') },
    {
      id: 'aggregator',
      icon: Building2,
      title: t('scope_aggregator'),
      hint: t('scope_aggregator_hint'),
    },
  ];
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="bd-card bd-shadow overflow-hidden py-2">
        {scopes.map((s, i) => {
          const list = visible.filter((r) => scopeOf(r) === s.id);
          if (list.length === 0) return null;
          return (
            <div
              key={s.id}
              className={cn(i > 0 && 'mt-1.5 border-t border-(--bd-border-soft) pt-2')}
            >
              <div className="flex items-center gap-2.5 px-[18px] pt-3 pb-2 text-[11px] font-bold tracking-[0.12em] text-ink-500 uppercase">
                <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-(--bd-border-soft)">
                  <s.icon size={14} aria-hidden="true" />
                </span>
                {s.title}
                <span className="ml-auto text-[12px] font-medium tracking-normal normal-case text-ink-400">
                  {s.hint}
                </span>
              </div>
              {list.map((r) => (
                <RoleRow key={r.key} role={r} current={current.key === r.key} onSelect={onSelect} />
              ))}
            </div>
          );
        })}
      </div>
      <RoleDetail
        role={current}
        permissions={permissions}
        personal={personal}
        total={permissions.filter((p) => !p.retired).length}
        onPermission={onPermission}
        query={query}
      />
    </div>
  );
}

/** One role in the list: its name, how it is granted and its permission count. */
function RoleRow({
  role,
  current,
  onSelect,
}: Readonly<{ role: CatalogueRole; current: boolean; onSelect: (key: string) => void }>) {
  const t = useTranslations('console.access');
  const assigned = role.granted.via === 'assignment';
  return (
    <button
      type="button"
      aria-pressed={current}
      onClick={() => onSelect(role.key)}
      className={cn(
        'relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 px-[18px] py-2.5 text-left hover:bg-(--bd-bg)',
        current &&
          'bg-(--bd-primary-50) before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-(--bd-primary) hover:bg-(--bd-primary-50)',
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            'grid h-[30px] w-[30px] flex-none place-items-center rounded-lg',
            assigned
              ? 'bg-(--bd-border-soft) text-ink-500'
              : 'bg-(--bd-primary-50) text-(--bd-primary-600)',
          )}
        >
          {assigned ? (
            <KeyRound size={15} aria-hidden="true" />
          ) : (
            <Shield size={15} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 font-bold text-ink-900">
            {role.name}
            <Badge tone={assigned ? 'muted' : 'brand'}>
              {assigned ? t('via_assigned') : t('via_automatic')}
            </Badge>
            {role.is_builtin ? null : <Badge tone="muted">{t('custom')}</Badge>}
          </span>
          {role.description ? (
            <span className="block truncate text-[12.5px] text-ink-500">{role.description}</span>
          ) : null}
        </span>
      </span>
      <span className="text-[12px] whitespace-nowrap text-ink-500">
        {t('permission_count', { count: role.permissions.length })}
      </span>
    </button>
  );
}
