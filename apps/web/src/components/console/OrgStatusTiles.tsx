'use client';

/**
 * Count tiles for organisations by status: all, active, pending review and
 * rejected. As links they open the organisations list with that filter; as
 * buttons they filter a list on the same page.
 */

import { useTranslations } from 'next-intl';
import { Building2, CircleCheck, Clock, CircleX, type LucideIcon } from 'lucide-react';
import type { OrgSearchResponse } from '@aggregator-dpg/shared-primitives/user-org';
import { CountTile, type TileTone } from './CountTile';

type OrgRow = OrgSearchResponse['orgs'][number];

/** A tile filter: every organisation, or one status. */
export type OrgFilter = 'all' | 'active' | 'pending' | 'inactive';

export const ORG_FILTERS: readonly OrgFilter[] = ['all', 'active', 'pending', 'inactive'];

const TILE: Record<OrgFilter, { icon: LucideIcon; tone: TileTone }> = {
  all: { icon: Building2, tone: 'primary' },
  active: { icon: CircleCheck, tone: 'green' },
  pending: { icon: Clock, tone: 'amber' },
  inactive: { icon: CircleX, tone: 'rose' },
};

/** Organisations counted by filter. */
export type OrgCounts = Record<OrgFilter, number>;

/**
 * Counts organisations by status.
 *
 * @param orgs - The organisations, any status.
 * @returns The total and the count for each status filter.
 */
export function countOrgs(orgs: readonly OrgRow[]): OrgCounts {
  const of = (s: OrgRow['status']) => orgs.filter((o) => o.status === s).length;
  return {
    all: orgs.length,
    active: of('active'),
    pending: of('pending'),
    inactive: of('inactive'),
  };
}

/**
 * Whether an organisation passes a filter.
 *
 * @param org - The organisation.
 * @param filter - The tile filter.
 */
export function matchesFilter(org: OrgRow, filter: OrgFilter): boolean {
  return filter === 'all' || org.status === filter;
}

export function OrgStatusTiles({
  counts,
  more = false,
  selected,
  onSelect,
  hrefs,
}: Readonly<{
  counts: OrgCounts;
  /** More organisations exist than were counted; counts show as "N+". */
  more?: boolean;
  selected?: OrgFilter | null;
  /** Makes the tiles filter buttons. */
  onSelect?: (f: OrgFilter) => void;
  /** Makes the tiles links, one per filter. */
  hrefs?: Readonly<Record<OrgFilter, string>>;
}>) {
  const t = useTranslations('console.orgs');
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      {ORG_FILTERS.map((f) => {
        const none = f === 'pending' && counts.pending === 0;
        return (
          <CountTile
            key={f}
            icon={TILE[f].icon}
            tone={TILE[f].tone}
            label={t(`tile.${f}.label`)}
            count={more ? `${counts[f]}+` : String(counts[f])}
            sub={none ? t('tile.pending.none') : t(`tile.${f}.sub`)}
            muted={none}
            selected={selected === f}
            showLabel={t('tile_show')}
            showingLabel={t('tile_showing')}
            {...(onSelect ? { onClick: () => onSelect(f) } : {})}
            {...(hrefs ? { href: hrefs[f] } : {})}
          />
        );
      })}
    </div>
  );
}
