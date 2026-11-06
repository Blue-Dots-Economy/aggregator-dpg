'use client';

/**
 * Body of a dashboard domain tab: summary, cards, tiles and table (`web` app).
 */
import { useAggregatorConfig } from '@/hooks/useAggregatorConfig';
import type { IconName } from '@/icons';
import type { ParticipantBase } from '@/types';
import { PAGE_SIZE } from '../_lib/query';
import { indexStatusRules } from '../_lib/status';
import { ParticipantTable } from './ParticipantTable';
import { RollupTiles } from './RollupTiles';
import { ErrorCard, LoadingCard } from './StateCards';
import { StatusCards } from './StatusCards';
import { SummaryBar } from './SummaryBar';
import { useDashboardRefresh } from './useDashboardRefresh';
import { useDomainDashboard, type RowMapper } from './useDomainDashboard';

/** Props for {@link DomainTab}. */
export interface DomainTabProps<R extends ParticipantBase> {
  /** The signed-in coordinator's own domain, from its `aggregator_type`. */
  domainId: string | undefined;
  kind: 'seeker' | 'provider';
  toRow: RowMapper<R>;
  /** Icon of the summary bar and the "active" card. */
  icon: IconName;
  /** Plural label when the domain config has none. */
  fallbackPlural: string;
  /** Label of the "active" card when config has none, given the plural label. */
  activeFallbackLabel: (plural: string) => string;
}

/**
 * One domain's dashboard.
 *
 * The status cards and tiles show the full rollup; the table shows the
 * filtered page.
 */
export function DomainTab<R extends ParticipantBase>({
  domainId,
  kind,
  toRow,
  icon,
  fallbackPlural,
  activeFallbackLabel,
}: DomainTabProps<R>) {
  const data = useDomainDashboard(domainId, toRow);
  const refresh = useDashboardRefresh(domainId, data.page, data.statusFilter);
  const { data: cfg } = useAggregatorConfig();
  const domainCfg = cfg?.domains?.find((d) => d.id === domainId);
  const plural = domainCfg?.plural_label ?? fallbackPlural;
  const buckets = cfg?.dashboardBuckets;

  return (
    <div className="flex flex-col gap-5">
      <SummaryBar
        icon={icon}
        label={plural}
        total={data.total}
        refreshing={refresh.refreshing}
        refreshError={refresh.refreshError}
        lastRefreshedAt={refresh.lastRefreshedAt}
        onRefresh={refresh.onRefresh}
      />
      <StatusCards
        byStatus={data.byStatus}
        statusRules={indexStatusRules(domainCfg?.status_rules)}
        statusLabels={buckets?.by_status ?? {}}
        activeIcon={icon}
        activeFallbackLabel={activeFallbackLabel(plural)}
      />
      <RollupTiles domainCfg={domainCfg} entityPlural={plural} rollup={data.rollup} />

      {data.isLoading ? (
        <LoadingCard />
      ) : data.isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable
          kind={kind}
          rows={data.rows}
          total={data.totalMatching ?? data.total}
          page={data.page}
          pageSize={PAGE_SIZE}
          onPageChange={data.setPage}
          statusFilter={data.statusFilter}
          onStatusFilterChange={data.onStatusFilterChange}
          statusOptions={data.statusOptions}
          initiatedLabels={buckets?.by_initiated_action_status ?? {}}
          receivedLabels={buckets?.by_received_action_status ?? {}}
          lifecycleFilter={data.lifecycleFilter}
          onLifecycleFilterChange={data.onLifecycleFilterChange}
          domain={domainId}
          onSelectAllMatching={data.fetchAllMatching}
        />
      )}
    </div>
  );
}
