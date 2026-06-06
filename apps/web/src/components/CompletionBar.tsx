/**
 * Accessible 0-100% completion bar. Clamps out-of-range inputs.
 *
 * @param percent - Completion percentage. Values outside [0, 100] are clamped.
 */
export function CompletionBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-2 w-24 rounded-full bg-slate-200 overflow-hidden"
    >
      <div
        className="h-full rounded-full bg-emerald-500 transition-[width]"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
