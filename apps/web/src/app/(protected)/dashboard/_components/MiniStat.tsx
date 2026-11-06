/**
 * Small metric tile for the dashboard's Profiles and Users groups (`web` app).
 */
import { I, type IconName } from '@/icons';

type DeltaTone = 'up' | 'down' | 'flat';

/** Props for {@link MiniStat}. */
export interface MiniStatProps {
  label: string;
  value: string;
  /** Optional leading icon rendered in a soft square next to the label. */
  icon?: IconName | undefined;
  /** Optional context line under the value (e.g. "50% of all profiles"). */
  sub?: string | undefined;
  delta?: string;
  deltaTone?: DeltaTone;
}

const DELTA_TONES: Record<DeltaTone, string> = {
  up: 'text-emerald-600 bg-emerald-50',
  down: 'text-rose-600 bg-rose-50',
  flat: 'text-ink-500 bg-ink-100',
};

/** Tile with a label, a value, and optional icon, delta and sub-line. */
export function MiniStat({ label, value, icon, sub, delta, deltaTone = 'flat' }: MiniStatProps) {
  const Ic = icon ? I[icon] : null;
  return (
    <div className="bd-card p-4 flex flex-col gap-2.5 transition-transform hover:-translate-y-0.5">
      <div className="flex items-center gap-2.5">
        {Ic && (
          <div className="w-8 h-8 rounded-[9px] bg-ink-50 text-ink-500 flex items-center justify-center shrink-0">
            <Ic size={16} />
          </div>
        )}
        <div className="text-[13px] text-ink-500 font-semibold">{label}</div>
      </div>
      {/* mt-auto keeps values aligned across a row when labels wrap. */}
      <div className="mt-auto flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <div className="font-display font-bold text-[26px] text-ink-900 leading-none tracking-tight">
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
        {/* min-h keeps values aligned when a tile has no sub-line. */}
        <div className="text-[12px] text-ink-400 font-medium min-h-[18px]">{sub}</div>
      </div>
    </div>
  );
}
