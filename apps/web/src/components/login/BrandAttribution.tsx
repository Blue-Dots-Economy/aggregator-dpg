import Image from 'next/image';
import type { JSX } from 'react';
import type { BrandAttribution as Row } from '../../hooks/useAggregatorConfig';

/**
 * "Owned by <X> / Managed by <Y>" rows (signals-dpg#720).
 *
 * Lives on the RIGHT pane, not the hero. `BrandPanel` is `hidden lg:flex`, so
 * anything placed there is invisible below 1024px — ownership attribution that
 * disappears on a phone is not attribution. The right pane renders at every
 * width.
 *
 * That also settles which artwork: the right pane is white, so these are the
 * same purple marks signals uses in its sidebar, rather than the white variants
 * the purple hero would have needed.
 *
 * Renders nothing when the brand declares no rows, which is every brand but
 * alimco.
 */
// `rows: Row[] | undefined`, not `rows?:` — this repo has
// `exactOptionalPropertyTypes: true`, under which an optional prop rejects an
// explicitly-passed `undefined`, which is exactly what `cfg.brand.attribution`
// is for every brand that declares none.
export function BrandAttribution({
  rows,
}: Readonly<{ rows: Row[] | undefined }>): JSX.Element | null {
  if (!rows?.length) return null;
  return (
    // Each row is a fixed-size box (`h-20 w-44`) so both marks get the same
    // amount of room regardless of their aspect ratio, and `object-left` pins
    // the artwork to the box's left edge — the same edge the caption starts
    // at, so the mark sits directly under its own label rather than drifting
    // toward the middle of a centred column.
    <div className="mt-8 flex items-start gap-12">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name}`} className="flex flex-col items-start gap-2">
          <span className="text-xs font-medium tracking-wide text-ink-400">{row.label}</span>
          {row.logo ? (
            <Image
              src={row.logo}
              alt={row.name}
              width={352}
              height={160}
              className="h-20 w-44 object-contain object-left"
            />
          ) : (
            <span className="text-sm font-semibold text-ink-900">{row.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
