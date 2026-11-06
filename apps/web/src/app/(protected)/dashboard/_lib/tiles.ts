/**
 * Icons and sub-lines for the dashboard's rollup tiles (`web` app).
 */
import type { useTranslations } from 'next-intl';
import type { IconName } from '@/icons';

/** Icon per known rollup tile field. Unknown fields have no icon. */
export const TILE_ICONS: Record<string, IconName> = {
  total_items: 'copy',
  complete_profiles: 'check',
  has_applications: 'send',
  total_users: 'users',
  avg_items_per_user: 'trending',
  avg_actions_per_user: 'spark',
};

/**
 * Returns the sub-line for a known rollup tile field.
 *
 * Returns undefined for unknown fields, and for the completion share when a
 * count is missing or the total is 0.
 *
 * @param field - The tile's rollup field name.
 * @param t - Dashboard-scoped translator.
 * @param entityPlural - Active domain's plural label for interpolation.
 * @param rollup - Domain rollup, used to derive the completion share.
 */
export function tileSub(
  field: string,
  t: ReturnType<typeof useTranslations>,
  entityPlural: string,
  rollup: { total_items: number; complete_profiles: number } | undefined,
): string | undefined {
  switch (field) {
    case 'total_items':
      return t('ministat.sub_total', { entityPlural });
    case 'complete_profiles': {
      if (!rollup || rollup.total_items <= 0) return undefined;
      return t('ministat.sub_complete', {
        pct: Math.round((rollup.complete_profiles / rollup.total_items) * 100),
      });
    }
    case 'has_applications':
      return t('ministat.sub_applications');
    case 'total_users':
      return t('ministat.sub_totalUsers');
    case 'avg_items_per_user':
      return t('ministat.sub_avgItems');
    case 'avg_actions_per_user':
      return t('ministat.sub_avgActions');
    default:
      return undefined;
  }
}
