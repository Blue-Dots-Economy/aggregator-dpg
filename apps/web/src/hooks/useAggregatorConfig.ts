'use client';

/**
 * `useAggregatorConfig` — reads the active deployment's brand + domain
 * config from the BFF, caching for the page session. Sidebar, topbar,
 * dashboard tabs, and (post-refactor) URL routes all read from here so
 * the same web image runs blue_dot / purple_dot / yellow_dot without
 * source changes.
 *
 * Falls back to a minimal Blue Dots default while the network call is
 * in flight so first paint is never blank. A *failed* call leaves callers on
 * that same default — intentionally, so the public form still works — but the
 * failure is logged to the console (see the effect in the hook body) rather
 * than swallowed, because degraded branding is otherwise indistinguishable
 * from a deployment that simply has no branding configured.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { jsonFetch } from '../services/http';

/**
 * One dashboard tile: which rollup key to read and what to call it. Mirrors
 * the network-config `DashboardTileDef`.
 */
export interface DashboardTileDef {
  field: string;
  label: string;
}

/**
 * Per-domain dashboard tiles, split into profile-level and user-level groups.
 * Both optional — UI falls back to default English tiles when absent.
 */
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
  /** Optional group-heading overrides; UI falls back to localised "Profiles" / "Users". */
  profile_title?: string;
  user_title?: string;
}

/**
 * Network-wide bucket-label overrides from network.json. Keys are the
 * canonical Signals vocab; values are network-specific copy. Action labels
 * are split by direction (initiated vs received).
 */
export interface DashboardBuckets {
  by_status?: {
    new?: string;
    active?: string;
    at_risk?: string;
    inactive?: string;
  };
  by_initiated_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
  by_received_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
}

/**
 * One entry of a domain's `status_rules` from network.json. `label` and
 * `description` are optional UI copy rendered on the dashboard status cards.
 */
export interface StatusRule {
  status: string;
  label?: string;
  description?: string;
}

export interface AggregatorConfigDomain {
  id: string;
  label: string;
  plural_label: string;
  item_type: string;
  /**
   * Mirrors network.json `guardian_consent_required`. Drives whether the
   * registration form collects a birth year (#613). Optional for back-compat
   * with an older config payload; treated as `false` when absent.
   */
  guardian_consent_required?: boolean;
  /**
   * Mirrors network.json `go_live_required`. The registration form shows the
   * consent step iff this includes `consent_required` (#613). Optional for
   * back-compat; treated as `[]` when absent.
   */
  go_live_required?: string[];
  dashboardTiles?: DashboardTiles;
  status_rules?: StatusRule[];
}

/**
 * One declared per-link registration mode from network config. `label_i18n_key`
 * names the admin dropdown label; `submission_shape` drives the public form;
 * `public_hint_i18n_key` (nullable) is rendered beneath the public form.
 */
export interface RegistrationModeConfig {
  label_i18n_key: string;
  submission_shape: 'account_only' | 'account_and_profile';
  public_hint_i18n_key: string | null;
  /**
   * Whether links in this mode offer the Signals UI hand-off. Resolved
   * server-side (the `submission_shape` default is already applied), so the
   * client reads it directly. Optional for back-compat with an older api build.
   */
  signals_cta?: boolean;
}

/**
 * Brand types mirror the Zod-inferred types exported from
 * `@aggregator-dpg/network-config/interface`. They are duplicated here
 * (as plain TS interfaces) instead of imported because the web app
 * deliberately avoids pulling the runtime Zod schemas into the client
 * bundle. Keep these in sync when `BrandConfigSchema` changes.
 */
export interface BrandPaletteSwatch {
  name: string;
  hex: string;
}

export interface BrandGradient {
  name: string;
  from: string;
  to: string;
}

export interface BrandPalette {
  primary?: BrandPaletteSwatch[];
  secondary?: BrandPaletteSwatch[];
  accent?: BrandPaletteSwatch[];
  gradients?: BrandGradient[];
}

export interface BrandTypographyFace {
  family: string;
  weight: string;
  sampleCopy?: string;
}

export interface BrandTypography {
  primaryFont: string;
  headings?: BrandTypographyFace;
  body?: BrandTypographyFace;
}

export interface BrandLogo {
  default?: string;
  light?: string;
  withStrapline?: string;
  withStraplineLight?: string;
  onBrand?: string;
}

export interface AggregatorConfigPayload {
  aggregator: {
    name: string;
    legal_name?: string;
    contact_email?: string;
  };
  brand: {
    short_name: string;
    long_name: string;
    tagline?: string;
    strapline?: string;
    url_slug: string;
    primary_color?: string;
    accent_color?: string;
    logo_url?: string;
    favicon_url?: string;
    palette?: BrandPalette;
    typography?: BrandTypography;
    logo?: BrandLogo;
  };
  network: {
    id: string;
    display_name?: string;
  };
  domains: AggregatorConfigDomain[];
  dashboardBuckets?: DashboardBuckets;
  /** Per-link registration modes declared by the network (admin dropdown source). */
  registration_modes?: Record<string, RegistrationModeConfig>;
  /**
   * Per-domain Signals UI login URLs, keyed by domain id. Absent or missing a
   * domain ⇒ no Signals hand-off for that domain.
   */
  signals_ui_urls?: Record<string, string>;
}

/**
 * Conservative fallback used while the first network call is in flight.
 * Matches the pre-genericisation defaults so existing screens render
 * exactly the same on a cold mount.
 */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfigPayload = {
  aggregator: { name: 'Aggregator' },
  brand: {
    short_name: 'Blue Dots',
    long_name: 'Blue Dots Aggregator Portal',
    tagline: 'Track every participant in your network — at a glance.',
    url_slug: 'dashboard',
    primary_color: '#2563EB',
  },
  network: { id: 'blue_dot' },
  domains: [
    { id: 'seeker', label: 'Seekers', plural_label: 'Seekers', item_type: 'profile_1.0' },
    { id: 'provider', label: 'Providers', plural_label: 'Providers', item_type: 'job_posting_1.0' },
  ],
};

export function useAggregatorConfig() {
  const query = useQuery({
    queryKey: ['aggregator-config'],
    queryFn: () => jsonFetch<AggregatorConfigPayload>('/api/aggregator-config'),
    // Brand + domains rarely change between deploys; stale data is fine.
    staleTime: 5 * 60 * 1000,
  });
  const { error } = query;
  // Degrading to DEFAULT_AGGREGATOR_CONFIG on failure is deliberate — first
  // paint is never blank and the public registration form still works. But
  // degraded is not the same as fine: the deployment's real branding is gone
  // and every config-gated surface (the #652 Signals hand-off chooser, the
  // per-domain consent/birth-year gates) silently turns off. Without this the
  // outage is invisible in the browser, which `.claude/rules/error-handling.md`
  // forbids. Logged here rather than in each consumer so every caller of this
  // hook is covered; react-query de-dupes the request, so a page with two
  // consumers emits one line per mounted consumer, not one per retry.
  useEffect(() => {
    if (!error) return;
    console.error(
      '[aggregator-config] fetch failed — falling back to default branding; config-gated surfaces (Signals hand-off, consent gates) will not render',
      {
        operation: 'aggregator-config.fetch',
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }, [error]);
  return query;
}
