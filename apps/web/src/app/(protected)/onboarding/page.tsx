'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../../components/ui/Button';
import { Topbar } from '../../../components/shell/Topbar';
import { I, type IconName } from '../../../icons';
import { useRecentBulkUploads, useRegistrationLinks } from '../../../hooks/useOnboarding';
import { useProfileRaw } from '../../../hooks/useProfile';
import { StatStrip } from './_components/StatStrip';

export default function OnboardingPage() {
  return (
    <div className="fade-up flex flex-col gap-3">
      <Topbar
        title="Onboarding"
        subtitle="Add participants to your network — by CSV, link, or QR."
        right={
          <button
            type="button"
            onClick={() => window.location.reload()}
            title="Refresh page"
            aria-label="Refresh page"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] border border-[var(--bd-border)] bg-white text-[12.5px] font-semibold text-ink-700 hover:text-primary-600 hover:bg-[var(--bd-primary-50)] transition-colors"
          >
            <I.refresh size={14} />
            Refresh
          </button>
        }
      />
      <StatStrip />
      <BulkUploadCard />
      <RegistrationLinkCard />
    </div>
  );
}

/**
 * Summary card for the bulk upload sub-flow. Counts come from the recent
 * uploads list (same hook the detail page uses). Click → /onboarding/bulk-uploads.
 */
function BulkUploadCard() {
  const router = useRouter();
  const recent = useRecentBulkUploads(50);
  const metrics = useMemo(() => {
    const items = recent.data?.items ?? [];
    let total = 0;
    let passed = 0;
    let failed = 0;
    let lastUploadAt: string | null = null;
    for (const it of items) {
      total += it.total_rows ?? 0;
      passed += it.passed ?? 0;
      failed += it.failed ?? 0;
      if (!lastUploadAt || it.created_at > lastUploadAt) lastUploadAt = it.created_at;
    }
    return { uploads: items.length, total, passed, failed, lastUploadAt };
  }, [recent.data]);

  return (
    <SummaryCard
      icon="upload"
      accent="primary"
      title="Bulk Upload"
      subtitle="CSV import for existing rosters. Fastest path for large batches."
      footnote={
        metrics.lastUploadAt
          ? `Last upload ${formatRelative(metrics.lastUploadAt)}`
          : recent.isLoading
            ? 'Loading…'
            : 'No uploads yet'
      }
      metrics={[
        { label: 'Files Uploaded', value: metrics.uploads, tone: 'ink' },
        { label: 'Rows', value: metrics.total, tone: 'ink' },
        { label: 'Passed', value: metrics.passed, tone: 'emerald' },
        { label: 'Failed', value: metrics.failed, tone: 'rose' },
      ]}
      loading={recent.isLoading}
      ctaLabel="Go to Bulk Upload"
      onCta={() => router.push('/onboarding/bulk-uploads')}
    />
  );
}

/**
 * Summary card for the registration link sub-flow. Counts come from the
 * existing links list (scoped to the aggregator's type). Click →
 * /onboarding/links.
 */
function RegistrationLinkCard() {
  const router = useRouter();
  const rawProfile = useProfileRaw();
  const aggregatorType: 'seeker' | 'provider' = rawProfile.data?.type ?? 'seeker';
  const links = useRegistrationLinks(aggregatorType);
  const metrics = useMemo(() => {
    const items = links.data ?? [];
    let total = 0;
    let passed = 0;
    let active = 0;
    let lastCreatedAt: string | null = null;
    for (const l of items) {
      if (l.status === 'live') active += 1;
      total += l.metrics?.total ?? 0;
      passed += l.metrics?.passed ?? 0;
      if (!lastCreatedAt || l.created_at > lastCreatedAt) lastCreatedAt = l.created_at;
    }
    return { links: items.length, active, total, passed, lastCreatedAt };
  }, [links.data]);

  return (
    <SummaryCard
      icon="link"
      accent="amber"
      title="Registration via Link"
      subtitle="Share a public link / QR. Participants self-register through it."
      footnote={
        metrics.lastCreatedAt
          ? `Last link ${formatRelative(metrics.lastCreatedAt)}`
          : links.isLoading
            ? 'Loading…'
            : 'No links yet'
      }
      metrics={[
        { label: 'Links', value: metrics.links, tone: 'ink' },
        { label: 'Active', value: metrics.active, tone: 'emerald' },
        { label: 'Registrations', value: metrics.total, tone: 'ink' },
        { label: 'Verified', value: metrics.passed, tone: 'emerald' },
      ]}
      loading={links.isLoading}
      ctaLabel="Go to Registration Links"
      onCta={() => router.push('/onboarding/links')}
    />
  );
}

type Accent = 'primary' | 'amber';

interface MetricItem {
  label: string;
  value: number;
  tone: 'ink' | 'emerald' | 'rose';
}

const ACCENT_BG: Record<Accent, string> = {
  primary: 'linear-gradient(180deg,#EEF2FF 0%,#FFFFFF 55%)',
  amber: 'linear-gradient(180deg,#FFFBEB 0%,#FFFFFF 55%)',
};

const ACCENT_ICON_RING: Record<Accent, string> = {
  primary: 'bg-white border border-[var(--bd-primary-100)] text-primary-600',
  amber: 'bg-white border border-amber-200 text-amber-700',
};

const ACCENT_BAR: Record<Accent, string> = {
  primary: 'bg-primary-600',
  amber: 'bg-amber-500',
};

interface SummaryCardProps {
  icon: IconName;
  accent: Accent;
  title: string;
  subtitle: string;
  footnote: ReactNode;
  metrics: MetricItem[];
  loading: boolean;
  ctaLabel: string;
  onCta: () => void;
}

function SummaryCard({
  icon,
  accent,
  title,
  subtitle,
  footnote,
  metrics,
  loading,
  ctaLabel,
  onCta,
}: SummaryCardProps) {
  const Ic = I[icon];
  return (
    <div
      className="bd-card bd-shadow overflow-hidden flex flex-col transition-shadow hover:shadow-lg"
      style={{ background: ACCENT_BG[accent] }}
    >
      <div className={`h-1 ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className="px-5 py-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start gap-3">
          <div
            className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 bd-shadow ${ACCENT_ICON_RING[accent]}`}
          >
            <Ic size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display font-bold text-[15px] text-ink-900 leading-tight">
              {title}
            </div>
            <div className="text-[12px] text-ink-500 mt-0.5 leading-snug">{subtitle}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {metrics.map((m) => (
            <MetricTile key={m.label} {...m} loading={loading} />
          ))}
        </div>

        <div className="mt-auto pt-2 border-t border-[var(--bd-border-soft)] flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[11.5px] text-ink-400">{footnote}</span>
          <Button onClick={onCta} icon={<I.arrowR size={14} />}>
            {ctaLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone, loading }: MetricItem & { loading: boolean }) {
  const toneCls =
    tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : 'text-ink-900';
  return (
    <div className="bg-white/70 backdrop-blur-sm border border-[var(--bd-border)] rounded-[10px] px-3 py-2 flex flex-col gap-0.5">
      <div
        className={`font-display font-bold text-[18px] tabular-nums leading-none tracking-tight ${toneCls}`}
      >
        {loading ? '…' : value}
      </div>
      <div className="text-[11px] text-ink-500 font-medium">{label}</div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}
