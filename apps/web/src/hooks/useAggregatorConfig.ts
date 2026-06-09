'use client';

/**
 * `useAggregatorConfig` — reads the active deployment's brand + domain
 * config from the BFF, caching for the page session. Sidebar, topbar,
 * dashboard tabs, and (post-refactor) URL routes all read from here so
 * the same web image runs blue_dot / purple_dot / yellow_dot without
 * source changes.
 *
 * Falls back to a minimal Blue Dots default while the network call is
 * in flight so first paint is never blank.
 */

import { useQuery } from '@tanstack/react-query';
import { jsonFetch } from '../services/http';

/**
 * Per-domain tile-label overrides from network.json. All keys optional —
 * UI falls back to generic defaults when undefined.
 */
export interface DashboardTileLabels {
  total_items?: string;
  complete_profiles?: string;
  has_applications?: string;
}

/**
 * Network-wide bucket-label overrides from network.json. Keys are the
 * canonical Signals vocab; values are network-specific copy.
 */
export interface DashboardBuckets {
  by_status?: {
    new?: string;
    active?: string;
    at_risk?: string;
    inactive?: string;
  };
  by_action_status?: {
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
  dashboardTiles?: DashboardTileLabels;
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
  return useQuery({
    queryKey: ['aggregator-config'],
    queryFn: () => jsonFetch<AggregatorConfigPayload>('/api/aggregator-config'),
    // Brand + domains rarely change between deploys; stale data is fine.
    staleTime: 5 * 60 * 1000,
  });
}
