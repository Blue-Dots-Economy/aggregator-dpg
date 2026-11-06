/**
 * The selected role on the roles tab: who holds it, where, how, and its
 * permissions grouped by area.
 */

import { useTranslations } from 'next-intl';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { groupByArea } from './catalogue-filters';
import { Badge, Meta, MiniStat, PermissionChip } from './CatalogueUi';

/** The selected role: who holds it, where, how, and its permissions by area. */
export function RoleDetail({
  role,
  permissions,
  personal,
  total,
  onPermission,
  query,
}: Readonly<{
  role: CatalogueRole;
  permissions: CataloguePermission[];
  personal: Set<string>;
  total: number;
  onPermission: (key: string) => void;
  query: string;
}>) {
  const t = useTranslations('console.access');
  const assigned = role.granted.via === 'assignment';
  const pd = role.permissions.filter((p) => personal.has(p)).length;
  const byArea = groupByArea(role.permissions, (p) => p);
  const describe = (key: string) => permissions.find((p) => p.key === key)?.description;
  const q = query.trim().toLowerCase();
  return (
    <aside className="bd-card bd-shadow sticky top-[76px] flex flex-col" aria-label={role.name}>
      <div className="flex flex-col gap-2.5 border-b border-(--bd-border-soft) px-[22px] pt-5 pb-4">
        <div className="text-[12px] text-ink-500">
          {role.held_in.map((o) => t(`org_${o}`)).join(' · ')}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-[20px] font-bold text-ink-900">{role.name}</h3>
            <div className="font-mono text-[12px] text-ink-500">{role.key}</div>
          </div>
          <Badge tone={assigned ? 'muted' : 'brand'}>
            {assigned ? t('via_assigned') : t('via_automatic')}
          </Badge>
        </div>
        {role.description ? <p className="text-ink-700">{role.description}</p> : null}
        <div className="flex flex-wrap gap-1.5">
          <Meta>{t(`held_by_${role.held_by}`)}</Meta>
          {role.held_in.map((o) => (
            <Meta key={o}>{t(`org_${o}`)}</Meta>
          ))}
          {role.max_days ? <Meta>{t('valid_for', { count: role.max_days })}</Meta> : null}
        </div>
      </div>
      <div className="flex flex-col gap-3.5 px-[22px] pt-4 pb-5">
        <div className="grid grid-cols-3 gap-2">
          <MiniStat
            value={`${role.permissions.length}`}
            suffix={` / ${total}`}
            label={t('stat_permissions')}
          />
          <MiniStat value={String(pd)} label={t('personal_data')} warn={pd > 0} />
          <MiniStat value={role.max_days ? String(role.max_days) : '—'} label={t('max_days')} />
        </div>
        <div className="text-[11px] font-bold tracking-[0.1em] text-ink-500 uppercase">
          {t('stat_permissions')}
        </div>
        {role.permissions.length === 0 ? (
          <p className="text-[13px] text-ink-500">{t('permission_count', { count: 0 })}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {[...byArea.entries()].map(([area, list]) => (
              <div key={area} className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-2">
                <div className="pt-1 font-mono text-[11px] font-semibold text-ink-400">{area}</div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((p) => (
                    <PermissionChip
                      key={p}
                      permission={p}
                      danger={personal.has(p)}
                      hit={!!q && p.includes(q)}
                      title={describe(p)}
                      onOpen={onPermission}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-(--bd-border-soft) px-[22px] py-3 text-[12.5px] text-ink-500">
        {assigned ? t('footer_assigned') : t('footer_membership')}
      </div>
    </aside>
  );
}
