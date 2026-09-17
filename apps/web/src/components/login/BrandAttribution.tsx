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
    // Marks are sized by HEIGHT only (`h-24 w-auto`), never by a fixed box, so
    // the column hugs its own mark and its width IS the mark's width. That is
    // what makes centring work here: `items-center` puts the caption on the
    // same centre line as the logo directly below it.
    //
    // Left-aligning instead does not read as aligned, even though it measures
    // flush: both marks are symmetric emblems whose visual weight sits inboard
    // of their left edge, so a caption starting at x=0 looks like it is sitting
    // to the left of its own logo.
    // `pl-6` insets the block from the column's left edge. It is the only
    // thing on the right pane that is not body copy, so starting it flush
    // with the headline and the sign-in card made it read as a fourth
    // paragraph rather than a footer credit.
    <div className="mt-16 flex items-start gap-8 pl-6">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name}`} className="flex flex-col items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-ink-400">{row.label}</span>
          {row.logo ? (
            <Image
              src={row.logo}
              alt={row.name}
              width={352}
              height={160}
              className="h-24 w-auto object-contain object-center"
            />
          ) : (
            <span className="text-sm font-semibold text-ink-900">{row.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
