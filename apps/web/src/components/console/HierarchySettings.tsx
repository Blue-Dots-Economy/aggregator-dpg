/**
 * The network's hierarchy settings, read-only: the tree limits, how many
 * organisations exist against the maximum, and each "known as" value with
 * the depths where it is allowed and how many organisations carry it. All of
 * it comes from the instance configuration.
 */

import { useTranslations } from 'next-intl';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { DetailList } from './ConsoleUi';

/**
 * Renders the hierarchy settings.
 *
 * @param hierarchy - The settings as read on the server.
 */
export function HierarchySettings({ hierarchy }: Readonly<{ hierarchy: OrgHierarchyResponse }>) {
  const t = useTranslations('console');
  const { limits } = hierarchy;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-500">{t('orgs.hierarchy_hint')}</p>
      <DetailList
        items={[
          { label: t('orgs.max_depth'), value: String(limits.max_depth) },
          {
            label: t('orgs.max_children'),
            value: limits.max_children === null ? t('orgs.no_limit') : String(limits.max_children),
          },
          {
            label: t('orgs.total_orgs'),
            value: t('orgs.n_of_max', {
              count: hierarchy.total_orgs,
              max: limits.max_total_orgs,
            }),
          },
        ]}
      />
      <div className="flex flex-col gap-2">
        <span className="bd-label">{t('orgs.known_as_values')}</span>
        <ul className="flex flex-col gap-2">
          {hierarchy.known_as.values.map((v) => (
            <li
              key={v.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ink-100 bg-white px-3 py-2 text-[13px]"
            >
              <span className="inline-flex items-center rounded-md bg-[var(--bd-tint-primary)] px-2 py-0.5 text-[12px] font-semibold text-primary-600">
                {v.name}
              </span>
              {v.system ? (
                <span className="text-[12px] text-ink-400">{t('orgs.system_value')}</span>
              ) : null}
              <span className="text-ink-600">
                {v.depths === null
                  ? t('orgs.any_depth')
                  : t('orgs.depths', { count: v.depths.length, list: v.depths.join(', ') })}
              </span>
              <span className="ml-auto text-[12px] text-ink-500">
                {t('orgs.value_orgs', { count: v.org_count })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
