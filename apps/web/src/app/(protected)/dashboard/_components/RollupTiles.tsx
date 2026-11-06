'use client';

/**
 * Profile and user rollup tiles of a dashboard domain tab (`web` app).
 */
import { useTranslations } from 'next-intl';
import type { AggregatorConfigDomain } from '@/hooks/useAggregatorConfig';
import type { DashboardRollup } from '@/services/dashboard.service';
import { resolveTiles } from '@/services/tiles';
import { fmtCount } from '../_lib/format';
import { TILE_ICONS, tileSub } from '../_lib/tiles';
import { MetricGroup } from './MetricGroup';
import { MiniStat } from './MiniStat';
import { useDefaultTiles } from './useDefaultTiles';

/** Props for {@link RollupTiles}. */
export interface RollupTilesProps {
  /** The domain's network config, for its tile definitions and titles. */
  domainCfg: AggregatorConfigDomain | undefined;
  /** The domain's plural label. */
  entityPlural: string;
  rollup: DashboardRollup | undefined;
}

/** The "Profiles" and "Users" tile groups, from config or the default tiles. */
export function RollupTiles({ domainCfg, entityPlural, rollup }: RollupTilesProps) {
  const t = useTranslations('dashboard');
  const defaultTiles = useDefaultTiles(entityPlural);
  const tiles = domainCfg?.dashboardTiles;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <MetricGroup title={tiles?.profile_title ?? t('groups.profiles')}>
        {resolveTiles(tiles?.profile, defaultTiles.profile, rollup).map((tile) => (
          <MiniStat
            key={`p-${tile.field}`}
            icon={TILE_ICONS[tile.field]}
            label={tile.label}
            value={fmtCount(tile.value)}
            sub={tileSub(tile.field, t, entityPlural, rollup)}
          />
        ))}
      </MetricGroup>
      <MetricGroup title={tiles?.user_title ?? t('groups.users')}>
        {resolveTiles(tiles?.user, defaultTiles.user, rollup).map((tile) => (
          <MiniStat
            key={`u-${tile.field}`}
            icon={TILE_ICONS[tile.field]}
            label={tile.label}
            value={fmtCount(tile.value)}
            sub={tileSub(tile.field, t, entityPlural, rollup)}
          />
        ))}
      </MetricGroup>
    </div>
  );
}
