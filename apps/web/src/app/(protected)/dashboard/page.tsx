'use client';

import { useState, useRef, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Button } from '../../../components/ui/Button';
import { StatusPill } from '../../../components/ui/StatusPill';
import { Avatar } from '../../../components/ui/Avatar';
import { SegmentedTabs, type SegmentedTab } from '../../../components/ui/SegmentedTabs';
import { Topbar } from '../../../components/shell/Topbar';
import { I, type IconName } from '../../../icons';
import { useProviders, useOppProviders, useDashboard } from '../../../hooks/useDashboard';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../../hooks/useAggregatorConfig';
import { dashboardService, triggerCsvDownload } from '../../../services/dashboard.service';
import { useProfileRaw } from '../../../hooks/useProfile';
import type { ParticipantBase, ParticipantStatus, Provider, Seeker } from '../../../types';

type Tab = 'seekers' | 'providers' | 'opp';

type StatTone = 'active' | 'risk' | 'inactive' | 'satisfied';

interface ToneConfig {
  ring: string;
  bg: string;
  icon: string;
  num: string;
}

const STAT_TONES: Record<StatTone, ToneConfig> = {
  active: {
    ring: '#A7F3D0',
    bg: 'linear-gradient(180deg,#ECFDF5 0%,#FFFFFF 70%)',
    icon: '#10B981',
    num: '#047857',
  },
  risk: {
    ring: '#FCD34D',
    bg: 'linear-gradient(180deg,#FFFBEB 0%,#FFFFFF 70%)',
    icon: '#F59E0B',
    num: '#B45309',
  },
  inactive: {
    ring: '#FCA5A5',
    bg: 'linear-gradient(180deg,#FEF2F2 0%,#FFFFFF 70%)',
    icon: '#EF4444',
    num: '#B91C1C',
  },
  satisfied: {
    ring: '#C7D2FE',
    bg: 'linear-gradient(180deg,#EEF2FF 0%,#FFFFFF 70%)',
    icon: '#6366F1',
    num: '#4338CA',
  },
};

interface StatCardProps {
  tone: StatTone;
  count: string;
  label: string;
  icon: IconName;
  hint?: string;
  action?: ReactNode;
}

function StatCard({ tone, count, label, icon, hint, action }: StatCardProps) {
  const t = STAT_TONES[tone] ?? STAT_TONES.inactive;
  const Ic = I[icon];
  return (
    <div
      className="bd-card bd-shadow p-5 flex flex-col gap-3 relative overflow-hidden"
      style={{ background: t.bg }}
    >
      <div className="flex items-start justify-between">
        <div
          className="w-9 h-9 rounded-[10px] flex items-center justify-center"
          style={{ background: '#fff', border: `1px solid ${t.ring}`, color: t.icon }}
        >
          <Ic size={18} />
        </div>
        {action}
      </div>
      <div>
        <div
          className="font-display font-bold text-[28px] leading-none tracking-tight"
          style={{ color: t.num }}
        >
          {count}
        </div>
        <div className="text-[13px] text-ink-500 mt-1.5 font-medium">{label}</div>
        {hint && <div className="text-[11.5px] text-ink-400 mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

type DeltaTone = 'up' | 'down' | 'flat';

interface MiniStatProps {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: DeltaTone;
}

const DELTA_TONES: Record<DeltaTone, string> = {
  up: 'text-emerald-600 bg-emerald-50',
  down: 'text-rose-600 bg-rose-50',
  flat: 'text-ink-500 bg-ink-100',
};

function MiniStat({ label, value, delta, deltaTone = 'flat' }: MiniStatProps) {
  return (
    <div className="bd-card p-4 flex flex-col gap-1.5">
      <div className="text-[12px] text-ink-400 font-medium">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="font-display font-bold text-[22px] text-ink-900 leading-none tracking-tight">
          {value}
        </div>
        {delta && (
          <span
            className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-md ${DELTA_TONES[deltaTone]}`}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}

type ChipTone = 'soft' | 'warm' | 'cool' | 'mute';

interface ActionChipProps {
  label: string;
  tone?: ChipTone;
  icon?: ReactNode;
}

const CHIP_TONES: Record<ChipTone, string> = {
  soft: 'bg-[var(--bd-primary-50)] text-primary-600 hover:bg-[var(--bd-primary-100)]',
  warm: 'bg-amber-50 text-amber-800 hover:bg-amber-100',
  cool: 'bg-sky-50 text-sky-800 hover:bg-sky-100',
  mute: 'bg-ink-100 text-ink-600 hover:bg-ink-200',
};

function ActionChip({ label, tone = 'soft', icon }: ActionChipProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold transition-colors ${CHIP_TONES[tone]}`}
    >
      {icon}
      {label}
    </button>
  );
}

interface FunnelPart {
  v: number;
  color: string;
  label: string;
  short: string;
}

interface FunnelCellProps {
  total: number;
  parts: FunnelPart[];
}

function FunnelCell({ total, parts }: FunnelCellProps) {
  const sum = parts.reduce((a, b) => a + b.v, 0) || 1;
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement | null>(null);

  const onEnter = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: r.left + window.scrollX, y: r.bottom + window.scrollY + 8 });
    setHover(true);
  };

  return (
    <>
      <div
        ref={ref}
        onMouseEnter={onEnter}
        onMouseLeave={() => setHover(false)}
        className="inline-flex items-center gap-2 cursor-default"
      >
        <span className="font-display font-bold text-[18px] text-ink-900 tabular-nums leading-none">
          {total}
        </span>
        <div className="flex h-1 w-16 rounded-full overflow-hidden bg-ink-100">
          {parts.map((p, i) => (
            <div key={i} style={{ width: `${(p.v / sum) * 100}%`, background: p.color }} />
          ))}
        </div>
      </div>

      {hover &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{ position: 'absolute', left: pos.x, top: pos.y, zIndex: 9999 }}
            className="bg-white border border-[var(--bd-border)] rounded-[10px] bd-shadow-lg p-2.5 min-w-[160px] pointer-events-none animate-[fadeUp_.12s_ease-out]"
          >
            <div className="flex flex-col gap-1.5">
              {parts.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
                  <span className="text-ink-500 flex-1">{p.label}</span>
                  <span className="font-semibold tabular-nums text-ink-900">{p.v}</span>
                </div>
              ))}
              <div className="border-t border-[var(--bd-border-soft)] mt-1 pt-1.5 flex items-center gap-2 text-[12px]">
                <span className="text-ink-400 flex-1">Total</span>
                <span className="font-display font-bold tabular-nums text-ink-900">{total}</span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ProgressTiny({ pct }: { pct: number }) {
  const color = pct >= 80 ? '#10B981' : pct >= 50 ? '#F59E0B' : '#EF4444';
  const label = pct >= 80 ? 'Complete' : 'Incomplete';
  return (
    <div className="flex items-center gap-2" title={`${label} · ${pct}%`}>
      <div className="w-14 h-1.5 rounded-full bg-ink-100 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[11px] tabular-nums text-ink-500 font-medium">{pct}%</span>
    </div>
  );
}

type RowKind = 'seeker' | 'provider' | 'opp';

interface RecommendedAction {
  label: string;
  tone: ChipTone;
  icon: ReactNode;
}

function recommendedActions(row: ParticipantBase, kind: RowKind): RecommendedAction[] {
  const out: RecommendedAction[] = [];
  if (row.status === 'at-risk')
    out.push({ label: 'Re-engage', tone: 'warm', icon: <I.send size={12} /> });
  if (row.status === 'inactive')
    out.push({ label: 'Send nudge', tone: 'mute', icon: <I.bell size={12} /> });
  if (!row.profile.verified)
    out.push({ label: 'Verify', tone: 'cool', icon: <I.shield size={12} /> });
  if (row.profile.complete < 70)
    out.push({ label: 'Complete profile', tone: 'soft', icon: <I.spark size={12} /> });
  if (kind === 'provider' && row.status === 'active')
    out.push({ label: 'Suggest match', tone: 'soft', icon: <I.trending size={12} /> });
  if (kind === 'seeker' && (row.applied.shortlisted ?? 0) >= 5)
    out.push({ label: 'Coach interview', tone: 'soft', icon: <I.message size={12} /> });
  if (out.length === 0)
    out.push({ label: 'View profile', tone: 'mute', icon: <I.external size={12} /> });
  return out.slice(0, 2);
}

interface ParticipantTableProps<R extends ParticipantBase> {
  kind: RowKind;
  rows: R[];
}

function ParticipantTable<R extends ParticipantBase>({ kind, rows }: ParticipantTableProps<R>) {
  const searchId = `bd-search-${kind}`;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Map UI kind onto the signalstack domain. `opp` rides on the provider
  // dataset until signalstack exposes a dedicated opportunity-provider
  // endpoint (mirrors the read path in dashboardService).
  const exportDomain: 'seeker' | 'provider' = kind === 'seeker' ? 'seeker' : 'provider';

  const onExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const result = await dashboardService.dashboardExport({ domain: exportDomain });
      triggerCsvDownload(result);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bd-card bd-shadow overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-3 border-b border-[var(--bd-border)]">
        <div className="font-display font-bold text-[15px] text-ink-900">
          {kind === 'seeker'
            ? 'Participants'
            : kind === 'opp'
              ? 'Opportunity Providers'
              : 'Providers'}
        </div>
        <span className="text-[12px] text-ink-400">
          {rows.length} of {rows.length}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              Search participants
            </label>
            <I.search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
            />
            <input
              id={searchId}
              aria-label="Search participants"
              className="bd-input w-[320px] text-[13px] py-1.5"
              style={{ paddingLeft: 36 }}
              placeholder={
                kind === 'seeker' ? 'Search name, ID, profile…' : 'Search org, role, ID…'
              }
            />
          </div>
          <Button kind="ghost" icon={<I.filter size={14} />}>
            All filters
          </Button>
          <Button
            kind="ghost"
            icon={<I.download size={14} />}
            onClick={onExportCsv}
            disabled={exporting}
            title={exportError ?? 'Export as CSV'}
            aria-label="Export as CSV"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </div>
      </div>

      <div className="overflow-auto scroll-x" style={{ maxHeight: 520 }}>
        <table className="bd-table" style={{ minWidth: kind === 'provider' ? 1180 : 1080 }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 4, background: '#FAFBFE' }}>
            <tr>
              <th
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 5,
                  background: '#FAFBFE',
                  minWidth: 240,
                }}
              >
                {kind === 'seeker' ? 'Participant' : 'Provider'}
              </th>
              <th>Joined</th>
              {kind === 'provider' && <th>Job Role</th>}
              <th>Profile Status</th>
              <th>Applied</th>
              <th>Pre-shortlisted</th>
              <th>Status</th>
              <th>Recommended Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const roleParts =
                kind === 'provider' ? (r as unknown as Provider).role.split(' · ') : [];
              return (
                <tr key={r.id} className="fade-up">
                  <td
                    style={{
                      position: 'sticky',
                      left: 0,
                      background: 'inherit',
                      backgroundColor: '#fff',
                      zIndex: 1,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <Avatar initials={r.avatar} />
                      <div className="min-w-0">
                        <div className="font-semibold text-ink-900 text-[14px] truncate flex items-center gap-1.5">
                          {r.name}
                          {r.profile.verified && (
                            <I.shield size={13} className="text-emerald-500" />
                          )}
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
                  {kind === 'provider' && (
                    <td>
                      <div className="text-[13px] font-medium text-ink-800">
                        {roleParts[0] ?? ''}
                      </div>
                      <div className="text-[11px] text-ink-400 mt-0.5">{roleParts[1] ?? ''}</div>
                    </td>
                  )}
                  <td>
                    <ProgressTiny pct={r.profile.complete} />
                  </td>
                  <td>
                    <FunnelCell
                      total={r.applied.total}
                      parts={[
                        {
                          v: r.applied.shortlisted ?? 0,
                          color: '#10B981',
                          label: 'Shortlisted',
                          short: 'Shortlisted',
                        },
                        {
                          v: r.applied.rejected,
                          color: '#EF4444',
                          label: 'Rejected',
                          short: 'Rejected',
                        },
                        {
                          v: r.applied.pending,
                          color: '#F59E0B',
                          label: 'Pending',
                          short: 'Pending',
                        },
                      ]}
                    />
                  </td>
                  <td>
                    <FunnelCell
                      total={r.pre.total}
                      parts={[
                        {
                          v: r.pre.accepted ?? 0,
                          color: '#6366F1',
                          label: 'Accepted',
                          short: 'Accepted',
                        },
                        {
                          v: r.pre.rejected,
                          color: '#EF4444',
                          label: 'Rejected',
                          short: 'Rejected',
                        },
                        {
                          v: r.pre.pending,
                          color: '#F59E0B',
                          label: 'Pending',
                          short: 'Pending',
                        },
                      ]}
                    />
                  </td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      {recommendedActions(r, kind).map((a, i) => (
                        <ActionChip key={i} {...a} />
                      ))}
                      <button
                        type="button"
                        className="w-7 h-7 rounded-md hover:bg-ink-100 flex items-center justify-center text-ink-400"
                        aria-label="More actions"
                      >
                        <I.more size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-5 py-3 border-t border-[var(--bd-border)] flex items-center justify-between text-[12.5px] text-ink-500">
        <div>
          Showing 1–{rows.length} of {rows.length}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400"
          >
            <I.chevL size={14} />
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded-md bg-[var(--bd-primary-50)] text-primary-600 font-semibold"
          >
            1
          </button>
          <button type="button" className="px-3 py-1 rounded-md hover:bg-ink-100">
            2
          </button>
          <button type="button" className="px-3 py-1 rounded-md hover:bg-ink-100">
            3
          </button>
          <button
            type="button"
            aria-label="Next page"
            className="px-2.5 py-1.5 rounded-md hover:bg-ink-100 text-ink-400"
          >
            <I.chevR size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-ink-400" style={{ opacity: 0.6 }}>
      Loading…
    </div>
  );
}

function ErrorCard() {
  return (
    <div className="bd-card bd-shadow p-8 text-[13px] text-rose-600">
      Failed to load. Please try again.
    </div>
  );
}

function SeekersTab() {
  // Signalstack's `/aggregator/dashboard` is the only endpoint that
  // correctly scopes participant lookups by the caller's signalstack org
  // (via the per-call `x-acting-org-id` header). The older
  // `/network/item/fetch_local` route (used by `useSeekers`) ignores the
  // `aggregator_id` body filter under the new onboard model, leaking
  // unscoped rows across aggregators — fixed here by dropping that hook
  // and sourcing both the rollup AND the participant rows from the
  // dashboard payload.
  const { data: dashboard, isLoading, isError } = useDashboard({ domain: 'seeker' });
  const rollup = dashboard?.rollup;
  const total = rollup?.participants_total;
  const byStatus = rollup?.by_status ?? {};
  // Signalstack's status taxonomy is open — pick the keys the UI cares
  // about; unknown ones still surface in the participants list.
  const active = byStatus['active'] ?? byStatus['new'];
  const atRisk = byStatus['at_risk'];
  const inactive = byStatus['inactive'];
  const applicationsTotal = rollup
    ? rollup.applications_pending + rollup.applications_accepted + rollup.applications_rejected
    : undefined;
  const rows = useMemo(
    () => (dashboard?.participants ?? []).map(toSeekerRow),
    [dashboard?.participants],
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          tone="active"
          icon="users"
          count={fmtCount(active)}
          label="Active seekers"
          hint="New or recently active"
        />
        <StatCard
          tone="risk"
          icon="alert"
          count={fmtCount(atRisk)}
          label="At Risk"
          hint="No activity 14–30 days"
        />
        <StatCard
          tone="inactive"
          icon="pause"
          count={fmtCount(inactive)}
          label="Inactive"
          hint="Dormant 30+ days"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat label="Total Participants" value={fmtCount(total)} />
        {/* Complete-profile count requires per-row aggregation that
            signalstack's rollup does not expose yet. */}
        <MiniStat label="Complete Profiles" value="—" />
        <MiniStat label="Seekers with Applications" value={fmtCount(applicationsTotal)} />
        {/* New-this-week needs a date-windowed rollup signalstack does
            not return today. */}
        <MiniStat label="New Participants" value="—" delta="this week" deltaTone="flat" />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable kind="seeker" rows={rows} />
      )}
    </div>
  );
}

/**
 * Render a numeric stat value, falling back to an em-dash when the
 * upstream rollup hasn't loaded yet or signalstack doesn't expose the
 * field.
 */
function fmtCount(n: number | null | undefined): string {
  if (n === undefined || n === null) return '—';
  return String(n);
}

/**
 * Maps a signalstack dashboard participant payload onto the `Seeker`
 * shape the participant table expects.
 *
 * Signalstack's dashboard endpoint returns participant summaries only
 * — `name`, `city`, and the role/exp profile fields are NOT in this
 * response. They live in the per-user item detail endpoint, which the
 * table does not yet call. Missing fields render as em-dashes; the
 * `complete` profile bar uses `profile_completion_pct` directly so the
 * progress indicator stays meaningful.
 */
function toSeekerRow(participant: Record<string, unknown>): Seeker {
  const userId = typeof participant.user_id === 'string' ? participant.user_id : '';
  const status = mapSeekerStatus(
    typeof participant.profile_status === 'string' ? participant.profile_status : null,
  );
  const completion =
    typeof participant.profile_completion_pct === 'number' ? participant.profile_completion_pct : 0;
  const created =
    typeof participant.profile_created_at === 'string' ? participant.profile_created_at : '';
  const updated =
    typeof participant.profile_last_updated_at === 'string'
      ? participant.profile_last_updated_at
      : '';
  return {
    id: userId,
    name: '—',
    city: '—',
    joined: created
      ? new Date(created).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : '—',
    avatar: '??',
    profile: { title: '—', exp: '—', verified: false, complete: completion },
    applied: {
      total: numberOr(participant.applications_total, 0),
      shortlisted: 0,
      accepted: numberOr(participant.applications_accepted, 0),
      rejected: numberOr(participant.applications_rejected, 0),
      pending: numberOr(participant.applications_pending, 0),
    },
    pre: { total: 0, shortlisted: 0, accepted: 0, rejected: 0, pending: 0 },
    status,
    last: updated ? formatRelative(updated) : '—',
  };
}

function mapSeekerStatus(raw: string | null): ParticipantStatus {
  if (raw === 'at_risk') return 'at-risk';
  if (raw === 'inactive') return 'inactive';
  if (raw === 'satisfied') return 'satisfied';
  return 'active';
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function ProvidersTab() {
  const { data, isLoading, isError } = useProviders();
  const rows: Provider[] = data ?? [];
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="satisfied"
          icon="check"
          count="9"
          label="Satisfied"
          hint="Roles filled successfully"
        />
        <StatCard
          tone="active"
          icon="briefcase"
          count="11"
          label="Active"
          hint="Currently hiring"
        />
        <StatCard tone="risk" icon="alert" count="3" label="At Risk" hint="Stalled requirements" />
        <StatCard
          tone="inactive"
          icon="pause"
          count="1"
          label="Inactive"
          hint="No openings 30+ days"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat label="Total Providers" value="24" delta="+3" deltaTone="up" />
        <MiniStat label="Verified Orgs" value="20" delta="83%" deltaTone="up" />
        <MiniStat label="Open Roles" value="77" delta="+18" deltaTone="up" />
        <MiniStat label="Hires this Month" value="34" delta="↑ 22%" deltaTone="up" />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable<Provider> kind="provider" rows={rows} />
      )}
    </div>
  );
}

function OppProvidersTab() {
  const { data, isLoading, isError } = useOppProviders();
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          tone="active"
          icon="spark"
          count="11"
          label="Active programs"
          hint="Cohorts running now"
        />
        <StatCard
          tone="satisfied"
          icon="check"
          count="5"
          label="Onboarded"
          hint="Producing placements"
        />
        <StatCard tone="risk" icon="alert" count="2" label="At Risk" hint="Low cohort completion" />
        <StatCard tone="inactive" icon="pause" count="0" label="Inactive" hint="None dormant" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MiniStat label="Total Programs" value="18" delta="+2" deltaTone="up" />
        <MiniStat label="Active Cohorts" value="31" delta="+5" deltaTone="up" />
        <MiniStat label="Trainees Engaged" value="612" delta="+58" deltaTone="up" />
        <MiniStat label="Placement Rate" value="46%" delta="↑ 4%" deltaTone="up" />
      </div>

      {isLoading ? (
        <LoadingCard />
      ) : isError ? (
        <ErrorCard />
      ) : (
        <ParticipantTable kind="opp" rows={data ?? []} />
      )}
    </div>
  );
}

/**
 * Builds the seeker tab label with the live participants_total from the
 * signalstack dashboard. Dot + count are suppressed while the rollup
 * loads so the chip doesn't flash a stale "·" with no number.
 */
function seekerTabLabel(count: number | undefined): SegmentedTab<Tab> {
  return {
    id: 'seekers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.users size={14} /> Seekers
        {count !== undefined && (
          <>
            <span className="text-ink-300">·</span> {count}
          </>
        )}
      </span>
    ),
  };
}

/**
 * Builds the provider tab label. Count source is TBD — signalstack's
 * dashboard endpoint is seeker-only today, so the chip stays
 * count-less for the provider tab until the provider rollout lands.
 */
function providerTabLabel(count: number | undefined): SegmentedTab<Tab> {
  return {
    id: 'providers',
    label: (
      <span className="inline-flex items-center gap-2">
        <I.briefcase size={14} /> Providers
        {count !== undefined && (
          <>
            <span className="text-ink-300">·</span> {count}
          </>
        )}
      </span>
    ),
  };
}

export default function DashboardPageRoot() {
  const rawProfile = useProfileRaw();
  // Wait for the profile to resolve before mounting any tab — the SeekersTab
  // and ProvidersTab kick off their own /api/dashboard/items?domain=... fetch
  // on mount, so rendering a default before we know the aggregator's type
  // fires a stale seeker request that a provider account should never make.
  const profileType = rawProfile.data?.type;
  if (!profileType) {
    return <DashboardLoadingFrame />;
  }
  return <DashboardContent aggregatorType={profileType} />;
}

function DashboardLoadingFrame() {
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
      />
      <div className="text-center text-[13px] text-ink-400 py-12">Loading…</div>
    </div>
  );
}

function DashboardContent({ aggregatorType }: { aggregatorType: 'seeker' | 'provider' }) {
  const router = useRouter();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Tabs are scoped to the aggregator's registered participant focus —
  // seeker aggregators see only Seekers; provider aggregators see only
  // Providers. The opposite primary tab is hidden, not just disabled.
  // The chip count reads from the same signalstack dashboard rollup the
  // tab body renders, so the header total never drifts from the table.
  const { data: dashboard } = useDashboard({
    domain: aggregatorType === 'provider' ? 'provider' : 'seeker',
  });
  const liveCount = dashboard?.rollup.participants_total;
  const tabItems = useMemo<SegmentedTab<Tab>[]>(
    () =>
      aggregatorType === 'provider' ? [providerTabLabel(liveCount)] : [seekerTabLabel(liveCount)],
    [aggregatorType, liveCount],
  );
  const [tab, setTab] = useState<Tab>(aggregatorType === 'provider' ? 'providers' : 'seekers');

  return (
    <div className="fade-up">
      <Topbar
        title={`My ${cfg.brand.short_name}`}
        subtitle={cfg.brand.tagline ?? 'Track every participant in your network — at a glance.'}
        right={
          <div className="flex items-center gap-2">
            <Button icon={<I.plus size={14} />} onClick={() => router.push('/onboarding')}>
              Add Participants
            </Button>
          </div>
        }
      />

      <SegmentedTabs<Tab> value={tab} onChange={setTab} items={tabItems} className="mb-6" />

      {tab === 'seekers' && <SeekersTab />}
      {tab === 'providers' && <ProvidersTab />}
      {tab === 'opp' && <OppProvidersTab />}
    </div>
  );
}
