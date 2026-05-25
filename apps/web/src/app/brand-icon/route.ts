/**
 * Dynamic favicon route. Replaces the static `app/icon.svg` so the
 * browser tab icon matches the active network's brand colour. The
 * route reads `primary_color` from the api's `/v1/aggregator-config`
 * endpoint and emits the same network-mark SVG re-tinted to that hex.
 *
 * Cached for five minutes (network config rarely changes; cache lets
 * the browser get the icon without round-tripping to the api on every
 * page load).
 */

import { NextResponse } from 'next/server';

const FALLBACK_PRIMARY = '#2563EB';
const FALLBACK_PRIMARY_DARK = '#1D4ED8';

function deriveDark(hex: string): string {
  // Tint towards black by ~12% — matches the ThemeProvider's
  // `--bd-primary-600` derivation so the centre orb stays a notch
  // darker than the outer dots.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return FALLBACK_PRIMARY_DARK;
  const num = parseInt(m[1]!, 16);
  const r = Math.round(((num >> 16) & 0xff) * 0.88);
  const g = Math.round(((num >> 8) & 0xff) * 0.88);
  const b = Math.round((num & 0xff) * 0.88);
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function rgbaTriple(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '37,99,235';
  const num = parseInt(m[1]!, 16);
  return `${(num >> 16) & 0xff},${(num >> 8) & 0xff},${num & 0xff}`;
}

interface BrandShape {
  primary_color?: string;
}

async function loadPrimary(): Promise<string> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiBase}/v1/aggregator-config`, {
      // Re-fetch every 5 minutes; brand colour is stable per release.
      next: { revalidate: 300 },
    });
    if (!res.ok) return FALLBACK_PRIMARY;
    const body = (await res.json()) as { brand?: BrandShape };
    return body?.brand?.primary_color ?? FALLBACK_PRIMARY;
  } catch {
    return FALLBACK_PRIMARY;
  }
}

export async function GET() {
  const primary = await loadPrimary();
  const primaryDark = deriveDark(primary);
  const primaryRgb = rgbaTriple(primary);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="13" fill="rgba(${primaryRgb},0.08)"/>
  <g stroke="rgba(${primaryRgb},0.3)" stroke-width="0.9" stroke-linecap="round">
    <line x1="24" y1="24" x2="8" y2="12"/>
    <line x1="24" y1="24" x2="40" y2="10"/>
    <line x1="24" y1="24" x2="42" y2="26"/>
    <line x1="24" y1="24" x2="34" y2="40"/>
    <line x1="24" y1="24" x2="14" y2="38"/>
    <line x1="24" y1="24" x2="6" y2="26"/>
  </g>
  <circle cx="8" cy="12" r="2.6" fill="${primary}"/>
  <circle cx="40" cy="10" r="2.0" fill="${primary}"/>
  <circle cx="42" cy="26" r="3.2" fill="${primary}"/>
  <circle cx="34" cy="40" r="2.4" fill="${primary}"/>
  <circle cx="14" cy="38" r="2.8" fill="${primary}"/>
  <circle cx="6" cy="26" r="2.0" fill="${primary}"/>
  <circle cx="24" cy="24" r="9.4" fill="rgba(${primaryRgb},0.35)"/>
  <circle cx="24" cy="24" r="5.4" fill="${primaryDark}"/>
</svg>`;
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
