/**
 * Labelled metric group for the dashboard (`web` app).
 */
import type { ReactNode } from 'react';

/** Props for {@link MetricGroup}. */
export interface MetricGroupProps {
  title: string;
  children: ReactNode;
}

/**
 * A heading over a responsive card grid.
 *
 * Used for the "Profiles" and "Users" sections.
 */
export function MetricGroup({ title, children }: MetricGroupProps) {
  // h-full + flex-1 keep side-by-side groups the same height.
  return (
    <div className="flex h-full flex-col">
      <div className="text-[11.5px] font-bold uppercase tracking-[.09em] text-ink-400 mb-3">
        {title}
      </div>
      <div className="grid flex-1 grid-cols-1 sm:grid-cols-3 gap-4">{children}</div>
    </div>
  );
}
