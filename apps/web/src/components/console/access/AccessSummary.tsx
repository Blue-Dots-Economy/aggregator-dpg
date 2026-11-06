/**
 * The four summary tiles above the catalogue. The roles and permissions
 * tiles open their tab; the personal-data tile toggles the filter.
 */

import { useTranslations } from 'next-intl';
import { Lock, Plus, Shield, TriangleAlert } from 'lucide-react';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { CountTile } from '@/components/console/CountTile';
import type { AccessTab } from './catalogue-filters';

/** Counts roles, live permissions, personal-data permissions and custom roles. */
export function AccessSummary({
  roles,
  live,
  view,
  personalOnly,
  onOpen,
  onTogglePersonal,
}: Readonly<{
  roles: CatalogueRole[];
  /** Permissions that are not retired. */
  live: CataloguePermission[];
  view: AccessTab;
  personalOnly: boolean;
  /** Opens a tab with the personal-data filter off. */
  onOpen: (tab: AccessTab) => void;
  onTogglePersonal: () => void;
}>) {
  const t = useTranslations('console.access');
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      <CountTile
        icon={<Shield size={20} strokeWidth={2} />}
        tone="primary"
        label={t('stat_roles')}
        count={String(roles.length)}
        sub={t('stat_roles_sub')}
        selected={view === 'roles' && !personalOnly}
        showLabel={t('tile_show')}
        showingLabel={t('tile_showing')}
        onClick={() => onOpen('roles')}
      />
      <CountTile
        icon={<Lock size={20} strokeWidth={2} />}
        tone="primary"
        label={t('stat_permissions')}
        count={String(live.length)}
        sub={t('stat_permissions_sub')}
        selected={view === 'permissions' && !personalOnly}
        showLabel={t('tile_show')}
        showingLabel={t('tile_showing')}
        onClick={() => onOpen('permissions')}
      />
      <CountTile
        icon={<TriangleAlert size={20} strokeWidth={2} />}
        tone="rose"
        label={t('stat_personal_data')}
        count={String(live.filter((p) => p.personal_data).length)}
        sub={t('stat_personal_data_sub')}
        selected={personalOnly}
        showLabel={t('tile_filter')}
        showingLabel={t('tile_filtering')}
        onClick={onTogglePersonal}
      />
      <CountTile
        icon={<Plus size={20} strokeWidth={2} />}
        tone="primary"
        label={t('stat_custom')}
        count={String(roles.filter((r) => !r.is_builtin).length)}
        sub={t('stat_custom_sub')}
        muted={roles.every((r) => r.is_builtin)}
      />
    </div>
  );
}
