'use client';

/**
 * One participant row of the dashboard table (`web` app).
 */
import { useTranslations } from 'next-intl';
import { Avatar } from '@/components/ui/Avatar';
import { StatusPill } from '@/components/ui/StatusPill';
import { I } from '@/icons';
import type { ParticipantBase } from '@/types';
import { actionTotal, buildActionParts } from '../_lib/funnel';
import { SELECT_COLUMN_WIDTH } from '../_lib/table-layout';
import { FunnelCell } from './FunnelCell';
import { ProgressTiny } from './ProgressTiny';

/** Props for {@link ParticipantRow}. */
export interface ParticipantRowProps {
  row: ParticipantBase;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  initiatedLabels: Record<string, string>;
  receivedLabels: Record<string, string>;
  /** Localised label for a bucket key without a config label. */
  bucketFallback: (key: string) => string;
}

/** Table row: select box, identity, joined date, completion, action funnels and status. */
export function ParticipantRow({
  row: r,
  selectable,
  selected,
  onToggle,
  initiatedLabels,
  receivedLabels,
  bucketFallback,
}: ParticipantRowProps) {
  const t = useTranslations('dashboard');
  return (
    <tr className="fade-up">
      <td
        className="bd-sticky-col"
        style={{
          background: 'inherit',
          backgroundColor: 'var(--bd-card)',
          zIndex: 1,
          width: SELECT_COLUMN_WIDTH,
        }}
      >
        {selectable && (
          <input
            type="checkbox"
            className="bd-check w-4 h-4 align-middle"
            checked={selected}
            onChange={onToggle}
            aria-label={t('aria.select_row', { name: r.name })}
          />
        )}
      </td>
      <td
        className="bd-sticky-col bd-sticky-col-2"
        style={{
          background: 'inherit',
          backgroundColor: 'var(--bd-card)',
          zIndex: 1,
        }}
      >
        <div className="flex items-center gap-3">
          <Avatar initials={r.avatar} />
          <div className="min-w-0">
            <div className="font-semibold text-ink-900 text-[14px] truncate flex items-center gap-1.5">
              {r.name}
              {r.profile.verified && <I.shield size={13} className="text-emerald-500" />}
            </div>
            <div className="text-[12px] text-ink-400 flex items-center gap-1.5 mt-0.5">
              <span className="font-mono">{r.id}</span>
              <span className="text-ink-200">·</span>
              <span>{r.city}</span>
            </div>
          </div>
        </div>
      </td>
      <td>
        <div className="text-[13px] text-ink-700">{r.joined}</div>
        <div className="text-[11px] text-ink-400 mt-0.5">last seen {r.last}</div>
      </td>
      <td>
        <ProgressTiny
          pct={r.profile.complete}
          title={
            r.lifecycle_status === 'live'
              ? t('filters.lifecycle_live')
              : t('filters.lifecycle_draft')
          }
        />
      </td>
      <td>
        <FunnelCell
          total={actionTotal(r.initiated)}
          parts={buildActionParts(r.initiated, initiatedLabels, bucketFallback)}
        />
      </td>
      <td>
        <FunnelCell
          total={actionTotal(r.received)}
          parts={buildActionParts(r.received, receivedLabels, bucketFallback)}
        />
      </td>
      <td>
        <StatusPill status={r.status} />
      </td>
    </tr>
  );
}
