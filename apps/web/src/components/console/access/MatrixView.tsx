/**
 * The matrix tab: which role grants which live permission, with each
 * role's total.
 */

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { cn } from '@/lib/cn';
import { areaLabel, groupByArea } from './catalogue-filters';
import { Empty } from './CatalogueUi';

/** Which role grants which permission, at a glance. */
export function MatrixView({
  roles,
  rows,
}: Readonly<{ roles: CatalogueRole[]; rows: CataloguePermission[] }>) {
  const t = useTranslations('console.access');
  if (roles.length === 0 || rows.length === 0) return <Empty>{t('matrix_empty')}</Empty>;
  const areas = groupByArea(rows, (p) => p.key);
  const sticky = 'sticky left-0 z-[1] bg-(--bd-card)';
  return (
    <div className="bd-card bd-shadow max-h-[70vh] overflow-auto">
      <table className="bd-table">
        <thead className="sticky top-0 z-[2]">
          <tr>
            <th className={cn(sticky, 'bg-(--bd-table-head-bg)')}>{t('col_permission')}</th>
            {roles.map((r) => (
              <th key={r.key} className="min-w-[110px] text-center tracking-normal! normal-case!">
                <span className="block text-[13px] font-bold text-ink-900">{r.name}</span>
                <span className="block text-[11.5px] font-medium text-ink-500">
                  {r.granted.via === 'assignment' ? t('via_assigned') : t('via_automatic')}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...areas.entries()].map(([area, list]) => [
            <tr key={`area-${area}`}>
              <td colSpan={roles.length + 1} className="bg-(--bd-bg) py-2!">
                <span className="sticky left-[14px] text-[11.5px] font-bold tracking-[0.08em] text-ink-500 uppercase">
                  {areaLabel(area)}
                </span>
              </td>
            </tr>,
            ...list.map((p) => (
              <tr key={p.key} className="group">
                <td className={cn(sticky, 'min-w-[260px] group-hover:bg-(--bd-table-head-bg)')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-ink-900">{p.description || p.key}</span>
                    {p.personal_data ? (
                      <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-700">
                        {t('personal_data')}
                      </span>
                    ) : null}
                  </div>
                  <div className="font-mono text-[11.5px] text-ink-400">{p.key}</div>
                </td>
                {roles.map((r) => (
                  <td key={r.key} className="text-center" title={`${r.name} · ${p.description}`}>
                    {r.permissions.includes(p.key) ? (
                      <span
                        className={cn(
                          'inline-grid h-[22px] w-[22px] place-items-center rounded-md',
                          p.personal_data
                            ? 'bg-rose-50 text-rose-600'
                            : 'bg-emerald-50 text-emerald-600',
                        )}
                      >
                        <Check size={13} strokeWidth={3} aria-label={t('yes')} />
                      </span>
                    ) : (
                      <span className="text-ink-300" aria-label={t('no')}>
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            )),
          ])}
        </tbody>
        <tfoot className="sticky bottom-0 z-[2]">
          <tr>
            <td
              className={cn(
                sticky,
                'border-t border-(--bd-border) bg-(--bd-bg) px-[14px] py-3 text-[12.5px] font-bold text-ink-700',
              )}
            >
              {t('total')}
            </td>
            {roles.map((r) => (
              <td
                key={r.key}
                className="border-t border-(--bd-border) bg-(--bd-bg) px-[14px] py-3 text-center text-[13px] font-bold text-ink-900"
              >
                {r.permissions.length}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
