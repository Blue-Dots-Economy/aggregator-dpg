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
    // Marks are sized by HEIGHT only (`h-20 w-auto`), never by a fixed box.
    // The two have different aspect ratios, so a shared fixed-width box left
    // a different amount of empty space to the right of each one — the
    // captions were flush with their boxes but the artwork underneath them
    // was not the same width, which reads as misalignment. With `w-auto` the
    // column hugs its own mark, so each caption spans exactly the mark below
    // it.
    //
    // Left edges of caption and mark measure flush to within ~2px, so the gap
    // is kept at 32px rather than 48: across a wide gap the eye compares the
    // two marks' centres of mass instead of their left edges, and the two have
    // very different shapes (a symmetric emblem vs a wide wordmark).
    <div className="mt-14 flex items-start gap-8">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name}`} className="flex flex-col items-start gap-2">
          <span className="text-xs font-medium tracking-wide text-ink-400">{row.label}</span>
          {row.logo ? (
            <Image
              src={row.logo}
              alt={row.name}
              width={352}
              height={160}
              className="h-20 w-auto object-contain object-left"
            />
          ) : (
            <span className="text-sm font-semibold text-ink-900">{row.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
