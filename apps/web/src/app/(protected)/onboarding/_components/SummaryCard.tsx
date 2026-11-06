import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { I, type IconName } from '@/icons';

type Accent = 'primary' | 'amber';

/** One metric tile of a {@link SummaryCard}. */
export interface MetricItem {
  label: string;
  value: number;
  tone: 'ink' | 'emerald' | 'rose';
}

const ACCENT_BG: Record<Accent, string> = {
  primary: 'linear-gradient(180deg, var(--bd-tint-primary) 0%, var(--bd-card) 55%)',
  amber: 'linear-gradient(180deg, var(--bd-tint-amber) 0%, var(--bd-card) 55%)',
};

const ACCENT_ICON_RING: Record<Accent, string> = {
  primary: 'bg-(--bd-card) border border-(--bd-primary-100) text-primary-600',
  amber: 'bg-(--bd-card) border border-(--bd-border) text-amber-500',
};

/** Props for {@link SummaryCard}. */
export interface SummaryCardProps {
  icon: IconName;
  accent: Accent;
  title: string;
  subtitle: string;
  footnote: ReactNode;
  metrics: MetricItem[];
  /** Shows `…` in every metric tile. */
  loading: boolean;
  ctaLabel: string;
  onCta: () => void;
  /** Optional body rendered below the action row inside the same card. */
  body?: ReactNode;
}

/** Onboarding overview card: title, metric tiles, footnote, action and an optional body. */
export function SummaryCard({
  icon,
  accent,
  title,
  subtitle,
  footnote,
  metrics,
  loading,
  ctaLabel,
  onCta,
  body,
}: Readonly<SummaryCardProps>) {
  const Ic = I[icon];
  return (
    <div
      className="bd-card bd-shadow overflow-hidden flex flex-col transition-shadow hover:shadow-lg"
      style={{ background: ACCENT_BG[accent] }}
    >
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

        <div className="pt-2 border-t border-(--bd-border-soft) flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[11.5px] text-ink-400">{footnote}</span>
          <Button onClick={onCta} icon={<I.arrowR size={14} />}>
            {ctaLabel}
          </Button>
        </div>

        {body && (
          <div className="pt-3 border-t border-(--bd-border-soft) bg-(--bd-card) -mx-5 -mb-4 px-5 pb-4 mt-1">
            {body}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({ label, value, tone, loading }: Readonly<MetricItem & { loading: boolean }>) {
  const toneCls =
    tone === 'emerald' ? 'text-emerald-600' : tone === 'rose' ? 'text-rose-600' : 'text-ink-900';
  return (
    <div className="bg-(--bd-card) border border-(--bd-border) rounded-[10px] px-3 py-2 flex flex-col gap-0.5">
      <div
        className={`font-display font-bold text-[18px] tabular-nums leading-none tracking-tight ${toneCls}`}
      >
        {loading ? '…' : value}
      </div>
      <div className="text-[11px] text-ink-500 font-medium">{label}</div>
    </div>
  );
}
