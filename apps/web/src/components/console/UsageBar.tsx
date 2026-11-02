/**
 * A thin bar showing how much of a limit is used, such as organisations out
 * of the network's maximum. A native `<progress>`, amber from 80% used.
 */

import { cn } from '../../lib/cn';

/** Share of the limit from which the bar turns amber. */
const NEAR_LIMIT = 0.8;

/**
 * @param props.label - Accessible name, such as "Organisations used".
 * @param props.value - How many are used.
 * @param props.max - The limit; 0 or less shows an empty bar.
 * @param props.className - Extra classes, such as spacing.
 */
export function UsageBar({
  label,
  value,
  max,
  className,
}: Readonly<{ label: string; value: number; max: number; className?: string }>) {
  const near = max > 0 && value / max >= NEAR_LIMIT;
  return (
    <progress
      aria-label={label}
      value={Math.min(value, Math.max(max, 0))}
      max={Math.max(max, 1)}
      className={cn(
        'block h-1.5 w-full appearance-none overflow-hidden rounded-full bg-(--bd-border-soft)',
        '[&::-webkit-progress-bar]:bg-(--bd-border-soft)',
        near
          ? '[&::-webkit-progress-value]:bg-amber-500 [&::-moz-progress-bar]:bg-amber-500'
          : '[&::-webkit-progress-value]:bg-(--bd-primary) [&::-moz-progress-bar]:bg-(--bd-primary)',
        className,
      )}
    />
  );
}
