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
    // Each row is a fixed box with a centred mark, not a shrink-to-fit column:
    // the two marks have different aspect ratios and different amounts of
    // built-in whitespace, so left-aligning them inside auto-width columns
    // makes one read as smaller than the other even at identical heights.
    // A shared `h-16 w-36` box with `object-center` gives them equal optical
    // weight and puts each caption directly over its own mark.
    <div className="mt-8 flex items-start gap-10">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name}`} className="flex flex-col items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-ink-400">{row.label}</span>
          {row.logo ? (
            <Image
              src={row.logo}
              alt={row.name}
              width={288}
              height={128}
              className="h-16 w-36 object-contain object-center"
            />
          ) : (
            <span className="text-sm font-semibold text-ink-900">{row.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
