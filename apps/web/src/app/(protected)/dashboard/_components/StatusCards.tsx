'use client';

/**
 * The four status cards of a dashboard domain tab (`web` app).
 */
import { useTranslations } from 'next-intl';
import type { IconName } from '@/icons';
import { fmtCount } from '../_lib/format';
import type { StatusCopy } from '../_lib/status';
import { StatCard } from './StatCard';

/** Props for {@link StatusCards}. */
export interface StatusCardsProps {
  /** Count per status key, from `rollup.by_status`. */
  byStatus: Record<string, number>;
  /** Copy from the domain's `status_rules`, by status key. */
  statusRules: Record<string, StatusCopy>;
  /** Labels from the network's `dashboardBuckets.by_status`. */
  statusLabels: Record<string, string>;
  /** Icon of the "active" card. */
  activeIcon: IconName;
  /** Label of the "active" card when config has none. */
  activeFallbackLabel: string;
}

/**
 * New, active, at-risk and inactive counts.
 *
 * Labels come from the domain's status rules, then the network's bucket labels,
 * then the default copy.
 */
export function StatusCards({
  byStatus,
  statusRules,
  statusLabels,
  activeIcon,
  activeFallbackLabel,
}: StatusCardsProps) {
  const t = useTranslations('dashboard');
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard
        tone="new"
        icon="spark"
        count={fmtCount(byStatus['new'] ?? 0)}
        label={statusRules['new']?.label ?? statusLabels['new'] ?? t('statuses.new')}
        hint={statusRules['new']?.description ?? t('hints.new')}
      />
      <StatCard
        tone="active"
        icon={activeIcon}
        count={fmtCount(byStatus['active'] ?? byStatus['new'])}
        label={statusRules['active']?.label ?? statusLabels['active'] ?? activeFallbackLabel}
        hint={statusRules['active']?.description ?? t('hints.active')}
      />
      <StatCard
        tone="risk"
        icon="alert"
        count={fmtCount(byStatus['at_risk'])}
        label={statusRules['at_risk']?.label ?? statusLabels['at_risk'] ?? t('statuses.at_risk')}
        hint={statusRules['at_risk']?.description ?? t('hints.at_risk')}
      />
      <StatCard
        tone="inactive"
        icon="pause"
        count={fmtCount(byStatus['inactive'])}
        label={statusRules['inactive']?.label ?? statusLabels['inactive'] ?? t('statuses.inactive')}
        hint={statusRules['inactive']?.description ?? t('hints.inactive')}
      />
    </div>
  );
}
