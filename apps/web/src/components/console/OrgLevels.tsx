/**
 * The configured levels of the network as a left-to-right strip: the network
 * at Level 0, then each level with its "known as" values and how many
 * organisations carry each. Read-only; levels change only in config.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { OrgHierarchyResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { I } from '../../icons';

/** One step of the strip. */
function LevelCard({
  level,
  children,
  footer,
}: Readonly<{ level: string; children: ReactNode; footer: string }>) {
  return (
    <li className="flex min-w-[170px] flex-1 flex-col gap-2 rounded-xl border border-ink-100 bg-white px-4 py-3 shadow-sm">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
        {level}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      <span className="mt-auto text-[12px] text-ink-500">{footer}</span>
    </li>
  );
}

/**
 * Renders the levels strip.
 *
 * @param hierarchy - The levels as read on the server.
 */
export function OrgLevels({ hierarchy }: Readonly<{ hierarchy: OrgHierarchyResponse }>) {
  const t = useTranslations('console');
  const arrow = (key: string) => (
    <li key={key} aria-hidden className="hidden items-center text-ink-300 sm:flex">
      <I.chevR size={16} />
    </li>
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-500">{t('orgs.levels_hint')}</p>
      <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
        <LevelCard level={t('orgs.level', { level: 0 })} footer={t('orgs.network_tag')}>
          <span className="inline-flex items-center gap-1.5 font-semibold text-ink-900">
            <I.briefcase size={14} className="text-primary-600" />
            {hierarchy.network.name}
          </span>
        </LevelCard>
        {hierarchy.levels.flatMap((l) => [
          arrow(`arrow-${l.level}`),
          <LevelCard
            key={l.level}
            level={t('orgs.level', { level: l.level })}
            footer={t('orgs.level_orgs', {
              count: l.values.reduce((n, v) => n + v.org_count, 0),
            })}
          >
            {l.values.map((v) => (
              <span
                key={v.key}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bd-tint-primary)] px-2 py-0.5 text-[12px] font-semibold text-primary-600"
              >
                {v.label}
                <span className="rounded bg-white px-1 text-[11px] font-medium text-ink-500">
                  {v.org_count}
                </span>
              </span>
            ))}
          </LevelCard>,
        ])}
      </ol>
    </div>
  );
}
