'use client';

/**
 * Default rollup tiles for the dashboard (`web` app).
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { DashboardTileDef } from '@/hooks/useAggregatorConfig';

/**
 * Default tile groups, used when network config has no `dashboard_tiles.profile`
 * or `dashboard_tiles.user`.
 *
 * @param entityPlural - The domain's plural label, used in tile labels.
 */
export function useDefaultTiles(entityPlural: string): {
  profile: DashboardTileDef[];
  user: DashboardTileDef[];
} {
  const t = useTranslations('dashboard');
  return useMemo(
    () => ({
      profile: [
        { field: 'total_items', label: t('ministat.totalItems', { entityPlural }) },
        { field: 'complete_profiles', label: t('ministat.completeProfiles') },
        { field: 'has_applications', label: t('ministat.withApplications', { entityPlural }) },
      ],
      user: [
        { field: 'total_users', label: t('ministat.totalUsers') },
        { field: 'avg_items_per_user', label: t('ministat.avgProfilesPerUser') },
        { field: 'avg_actions_per_user', label: t('ministat.avgActionsPerUser') },
      ],
    }),
    [t, entityPlural],
  );
}
