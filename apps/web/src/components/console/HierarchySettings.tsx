/**
 * The network's hierarchy settings: the tree limits and how many
 * organisations exist against the maximum, read-only from the instance
 * configuration, and the editor for the "known as" values the network
 * defines for top-level organisations.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { KnownAsValuesEditor } from './KnownAsValuesEditor';

/** Usage at or above this share of the maximum shows in amber. */
const NEAR_LIMIT = 0.8;

/**
 * Renders the hierarchy settings.
 *
 * @param hierarchy - The settings as read on the server.
 */
export function HierarchySettings({ hierarchy }: Readonly<{ hierarchy: OrgHierarchyResponse }>) {
  const t = useTranslations('console');
  const { limits } = hierarchy;
  const used = limits.max_total_orgs > 0 ? hierarchy.total_orgs / limits.max_total_orgs : 0;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] text-ink-500">{t('orgs.hierarchy_hint')}</p>

      <div className="grid gap-3 md:grid-cols-3">
        <LimitCard
          label={t('orgs.max_depth')}
          value={String(limits.max_depth)}
          sub={t('orgs.max_depth_sub')}
        />
        <LimitCard
          label={t('orgs.max_children')}
          value={limits.max_children === null ? t('orgs.no_limit') : String(limits.max_children)}
          sub={t('orgs.max_children_sub')}
        />
        <LimitCard
          label={t('orgs.total_orgs')}
          value={t('orgs.n_of_max', { count: hierarchy.total_orgs, max: limits.max_total_orgs })}
          sub={t('orgs.total_orgs_sub')}
        >
          <div
            role="progressbar"
            aria-label={t('orgs.total_orgs')}
            aria-valuemin={0}
            aria-valuemax={limits.max_total_orgs}
            aria-valuenow={hierarchy.total_orgs}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-(--bd-border-soft)"
          >
            <div
              className={used >= NEAR_LIMIT ? 'h-full bg-amber-500' : 'h-full bg-(--bd-primary)'}
              style={{ width: `${Math.min(used, 1) * 100}%` }}
            />
          </div>
        </LimitCard>
      </div>

      <section>
        <h3 className="mb-2 text-[13px] font-bold text-ink-900">{t('orgs.top_level_known_as')}</h3>
        <KnownAsValuesEditor
          orgId={hierarchy.network.id}
          values={hierarchy.network.known_as_values}
        />
      </section>
    </div>
  );
}

/** One read-only limit: a label, the value and a short line. */
function LimitCard({
  label,
  value,
  sub,
  children,
}: Readonly<{
  label: string;
  value: string;
  sub: string;
  children?: ReactNode;
}>) {
  return (
    <div className="flex flex-col gap-1 rounded-[12px] border border-(--bd-border) bg-(--bd-bg) px-4 py-3.5">
      <span className="text-[12.5px] text-ink-500">{label}</span>
      <b className="font-display text-[20px] font-extrabold leading-tight text-ink-900">{value}</b>
      <small className="text-[12px] text-ink-400">{sub}</small>
      {children}
    </div>
  );
}
