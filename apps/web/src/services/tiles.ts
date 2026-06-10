/**
 * Dashboard tile resolution for the web app. Maps config-sourced (or
 * default) tile definitions onto the signalstack rollup so the dashboard
 * never aggregates — it only reads precomputed fields.
 *
 * @module apps/web/services/tiles
 */

/** Structural shape of a tile definition (mirrors `DashboardTileDef`). */
export interface TileDef {
  field: string;
  label: string;
}

/** A tile def joined with its numeric value read from the rollup. */
export interface ResolvedTile {
  field: string;
  label: string;
  value: number;
}

/**
 * Resolves tile defs from config (falling back to defaults) and reads each
 * tile's value from the precomputed rollup by `field`.
 *
 * While the rollup is still loading (`undefined`), every tile renders with
 * value 0 so the grid keeps its shape. Once the rollup is present, a tile
 * whose `field` does not resolve to a numeric value (unknown field, or an
 * object-valued field like `by_status`) is skipped with a console warning —
 * rendering it would show `[object Object]` or lie with a 0.
 *
 * @param defs - Config-sourced tile defs for this group, or undefined.
 * @param fallback - Default tiles to use when `defs` is empty/undefined.
 * @param rollup - The domain rollup to read values from.
 * @returns Tiles safe to render, in definition order.
 */
export function resolveTiles(
  defs: TileDef[] | undefined,
  fallback: TileDef[],
  rollup: object | undefined,
): ResolvedTile[] {
  const source = defs && defs.length ? defs : fallback;
  if (!rollup) {
    return source.map((d) => ({ field: d.field, label: d.label, value: 0 }));
  }
  // Single contained widening — every read is runtime-checked below, so a
  // non-numeric (or absent) field can never reach the UI.
  const byField = rollup as Record<string, unknown>;
  const out: ResolvedTile[] = [];
  for (const d of source) {
    const v = byField[d.field];
    if (typeof v !== 'number') {
      console.warn(
        `dashboard tile "${d.field}" skipped — rollup field is ${v === undefined ? 'missing' : 'not numeric'}`,
      );
      continue;
    }
    out.push({ field: d.field, label: d.label, value: v });
  }
  return out;
}
