'use client';

/**
 * Count tiles for organisations by status: all, active, pending review and
 * rejected. As links they open the organisations list with that filter; as
 * buttons they filter a list on the same page.
 */

import { useTranslations } from 'next-intl';
import { Building2, CircleCheck, Clock, CircleX, type LucideIcon } from 'lucide-react';
import { CountTile, type TileTone } from './CountTile';
import { ORG_FILTERS, type OrgCounts, type OrgFilter } from '../../lib/org-filters';

const TILE: Record<OrgFilter, { icon: LucideIcon; tone: TileTone }> = {
  all: { icon: Building2, tone: 'primary' },
  active: { icon: CircleCheck, tone: 'green' },
  pending: { icon: Clock, tone: 'amber' },
  inactive: { icon: CircleX, tone: 'rose' },
};

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
