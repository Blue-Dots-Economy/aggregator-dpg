'use client';

import { useEffect, type ReactNode } from 'react';
import { useAggregatorConfig } from '../hooks/useAggregatorConfig';

/**
 * Reads the active aggregator config and writes the brand colors onto
 * `:root` as CSS variables. All tailwind utilities + components key off
 * these variables, so a single config change repaints the entire UI
 * without touching component source.
 *
 * Two layers of variables:
 *
 *   1. **Primary ramp** (always set) — `--bd-primary*`, `--bd-brand`.
 *      Derived from YAML `primary_color` + `accent_color` via hex mix
 *      so brand only has to specify the base + accent.
 *   2. **Design-system tokens** (set when `brand.json` is present) —
 *      `--bd-secondary-1..N`, `--bd-accent-1..N`,
 *      `--bd-gradient-<name>`, `--bd-font-sans`. Read from the
 *      `palette` / `typography` blocks loaded out of `brand.json`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: cfg } = useAggregatorConfig();
  const primary = cfg?.brand.primary_color;
  const accent = cfg?.brand.accent_color;
  const palette = cfg?.brand.palette;
  const typography = cfg?.brand.typography;

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

  useEffect(() => {
    if (typeof document === 'undefined' || !palette) return;
    const root = document.documentElement;
    const writeSwatches = (
      group: 'secondary' | 'accent',
      swatches: { name: string; hex: string }[] | undefined,
    ) => {
      if (!swatches) return;
      swatches.forEach((s, idx) => {
        root.style.setProperty(`--bd-${group}-${idx + 1}`, s.hex);
        root.style.setProperty(`--bd-${group}-${slug(s.name)}`, s.hex);
      });
    };
    writeSwatches('secondary', palette.secondary);
    writeSwatches('accent', palette.accent);
    palette.gradients?.forEach((g) => {
      root.style.setProperty(
        `--bd-gradient-${slug(g.name)}`,
        `linear-gradient(135deg, ${g.from}, ${g.to})`,
      );
    });
  }, [palette]);

  useEffect(() => {
    if (typeof document === 'undefined' || !typography) return;
    const root = document.documentElement;
    root.style.setProperty('--bd-font-sans', typography.primaryFont);
    if (typography.headings?.family) {
      root.style.setProperty('--bd-font-heading', typography.headings.family);
    }
    if (typography.body?.family) {
      root.style.setProperty('--bd-font-body', typography.body.family);
    }
  }, [typography]);

  return <>{children}</>;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
