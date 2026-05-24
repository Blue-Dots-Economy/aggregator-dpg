'use client';

import { useEffect, type ReactNode } from 'react';
import { useAggregatorConfig } from '../hooks/useAggregatorConfig';

/**
 * Reads the active aggregator config and writes the brand colors onto
 * `:root` as CSS variables (`--bd-primary*`, `--bd-brand*`). All
 * tailwind utilities + components key off these variables, so a single
 * config change repaints the entire UI without touching component
 * source. Derived tint/shade ramps come from a lightweight hex-mix
 * helper so the brand only has to specify the base + accent colors.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: cfg } = useAggregatorConfig();
  const primary = cfg?.brand.primary_color;
  const accent = cfg?.brand.accent_color;

  useEffect(() => {
    if (typeof document === 'undefined' || !primary) return;
    const root = document.documentElement;
    const accentHex = accent ?? primary;
    root.style.setProperty('--bd-primary', primary);
    root.style.setProperty('--bd-primary-600', mix(primary, '#000000', 0.15));
    root.style.setProperty('--bd-primary-500', accentHex);
    root.style.setProperty('--bd-primary-100', mix(primary, '#ffffff', 0.85));
    root.style.setProperty('--bd-primary-50', mix(primary, '#ffffff', 0.92));
    // Brand-accent (success-coded surfaces — sign-out hover, badge dots)
    // doubles as the primary for now. Override per-deployment later if
    // the brand wants distinct accent + brand colors.
    root.style.setProperty('--bd-brand', accentHex);
  }, [primary, accent]);

  return <>{children}</>;
}

/**
 * Mix two hex colors `weight` toward `b`. `weight=0` returns `a`,
 * `weight=1` returns `b`. Inputs may be `#rrggbb` (with or without a
 * leading `#`). Unknown / malformed colors fall through to `a`.
 */
function mix(a: string, b: string, weight: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return a;
  const w = Math.max(0, Math.min(1, weight));
  const r = Math.round(A[0] * (1 - w) + B[0] * w);
  const g = Math.round(A[1] * (1 - w) + B[1] * w);
  const bl = Math.round(A[2] * (1 - w) + B[2] * w);
  return '#' + [r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function parseHex(c: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const hex = m[1]!;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
