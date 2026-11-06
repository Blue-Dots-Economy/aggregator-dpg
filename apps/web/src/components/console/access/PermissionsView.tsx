/**
 * The permissions tab: every permission grouped by area, with its
 * personal-data flag and the roles that grant it.
 */

import { useTranslations } from 'next-intl';
import { CircleAlert } from 'lucide-react';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { cn } from '@/lib/cn';
import { groupByArea } from './catalogue-filters';
import { Empty } from './CatalogueUi';

/** Every permission, grouped by area, with what grants it. */
export function PermissionsView({
  roles,
  rows,
  highlight,
  onRole,
}: Readonly<{
  roles: CatalogueRole[];
  rows: CataloguePermission[];
  highlight: string | null;
  onRole: (key: string) => void;
}>) {
  const t = useTranslations('console.access');
  if (rows.length === 0) return <Empty>{t('permissions_empty')}</Empty>;
  const areas = groupByArea(rows, (p) => p.key);
  const nameOf = (key: string) => roles.find((r) => r.key === key)?.name ?? key;
  return (
    <div className="bd-card bd-shadow overflow-auto">
      <table className="bd-table">
        <thead className="sticky top-0 z-[1]">
          <tr>
            <th>{t('col_permission')}</th>
            <th>{t('col_description')}</th>
            <th>{t('col_personal_data')}</th>
            <th>{t('col_granted_by')}</th>
          </tr>
        </thead>
        <tbody>
          {[...areas.entries()].map(([area, list]) => [
            <tr key={`area-${area}`}>
              <td
                colSpan={4}
                className="bg-(--bd-bg) font-mono text-[11.5px] font-semibold text-ink-500"
              >
                {area}.*
                <span className="ml-1.5 font-sans font-medium text-ink-400">{list.length}</span>
              </td>
            </tr>,
            ...list.map((p) => (
              <tr
                key={p.key}
                id={`permission-${p.key}`}
                className={cn(highlight === p.key && '[&>td]:bg-(--bd-primary-50)')}
              >
                <td className="font-mono text-[13px] font-semibold whitespace-nowrap text-ink-900">
                  {p.key}
                  {p.retired ? (
                    <span className="ml-2 rounded-full bg-(--bd-border-soft) px-2 py-0.5 font-sans text-[11px] font-semibold text-ink-500">
                      {t('retired')}
                    </span>
                  ) : null}
                </td>
                <td className="max-w-[520px] text-ink-700">{p.description}</td>
                <td>
                  {p.personal_data ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-[12px] font-bold text-rose-700">
                      ● {t('yes')}
                    </span>
                  ) : (
                    <span className="text-[13px] text-ink-400">{t('no')}</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {p.granted_by_roles.length ? (
                      p.granted_by_roles.map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => onRole(k)}
                          className="rounded-md border border-transparent bg-(--bd-border-soft) px-2 py-0.5 text-[12.5px] font-medium text-ink-700 hover:border-(--bd-primary-100) hover:bg-(--bd-primary-50) hover:text-(--bd-primary-600)"
                        >
                          {nameOf(k)}
                        </button>
                      ))
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-0.5 text-[12.5px] font-semibold text-amber-700">
                        <CircleAlert size={13} aria-hidden="true" />
                        {t('granted_by_none')}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}
