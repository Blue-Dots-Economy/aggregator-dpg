'use client';

/**
 * Reads the deployment's brand and domain config from the BFF (web app).
 *
 * The sidebar, topbar and dashboard tabs read from here, so one web image
 * serves any network. Returns a Blue Dots default while loading, and also
 * after a failed fetch, which is logged to the console.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BrandAttributionSchema,
  BrandLogoSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  RegistrationModeSchema,
  type BrandTypographyFaceSchema,
  type GradientSchema,
  type PaletteSwatchSchema,
} from '@aggregator-dpg/network-config/interface';
import { ResponseShapeError, jsonFetch } from '../services/http';

/** One dashboard tile: the rollup key to read and its label. Mirrors network-config `DashboardTileDef`. */
const DashboardTileDefSchema = z.object({ field: z.string(), label: z.string() });
export type DashboardTileDef = z.infer<typeof DashboardTileDefSchema>;

/** Profile and user tiles for one domain's dashboard. Mirrors network-config `DashboardTiles`. */
const DashboardTilesSchema = z.object({
  profile: z.array(DashboardTileDefSchema).optional(),
  user: z.array(DashboardTileDefSchema).optional(),
  profile_title: z.string().optional(),
  user_title: z.string().optional(),
});
export type DashboardTiles = z.infer<typeof DashboardTilesSchema>;

/**
 * Labels for the dashboard's status and action buckets, keyed by bucket.
 * Mirrors network-config `DashboardBuckets`.
 */
const DashboardBucketsSchema = z.object({
  by_status: z.record(z.string()).optional(),
  by_initiated_action_status: z.record(z.string()).optional(),
  by_received_action_status: z.record(z.string()).optional(),
});
export type DashboardBuckets = z.infer<typeof DashboardBucketsSchema>;

/** One status a domain's items can be in, with its label. Mirrors network-config `StatusRule`. */
const StatusRuleSchema = z.object({
  status: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
});
export type StatusRule = z.infer<typeof StatusRuleSchema>;

const AggregatorConfigDomainSchema = z.object({
  id: z.string(),
  label: z.string(),
  plural_label: z.string(),
  item_type: z.string(),
  guardian_consent_required: z.boolean().optional(),
  go_live_required: z.array(z.string()).optional(),
  dashboardTiles: DashboardTilesSchema.optional(),
  status_rules: z.array(StatusRuleSchema).optional(),
});
export type AggregatorConfigDomain = z.infer<typeof AggregatorConfigDomainSchema>;

/** A registration mode as the API serves it, with `signals_cta` resolved to a boolean. */
const RegistrationModeConfigSchema = RegistrationModeSchema.extend({ signals_cta: z.boolean() });
export type RegistrationModeConfig = z.infer<typeof RegistrationModeConfigSchema>;

export type BrandPaletteSwatch = z.infer<typeof PaletteSwatchSchema>;
export type BrandGradient = z.infer<typeof GradientSchema>;
export type BrandPalette = z.infer<typeof BrandPaletteSchema>;
export type BrandTypographyFace = z.infer<typeof BrandTypographyFaceSchema>;
export type BrandTypography = z.infer<typeof BrandTypographySchema>;
export type BrandLogo = z.infer<typeof BrandLogoSchema>;
export type BrandAttribution = z.infer<typeof BrandAttributionSchema>;

/**
 * Response of `GET /api/aggregator-config`.
 *
 * Brand parts reuse the network-config schemas, so the web reads the same
 * shape the API validated at boot.
 */
export const AggregatorConfigPayloadSchema = z.object({
  aggregator: z.object({
    name: z.string(),
    legal_name: z.string().optional(),
    contact_email: z.string().optional(),
  }),
  brand: z.object({
    short_name: z.string(),
    long_name: z.string(),
    tagline: z.string().optional(),
    strapline: z.string().optional(),
    url_slug: z.string(),
    primary_color: z.string().optional(),
    accent_color: z.string().optional(),
    logo_url: z.string().optional(),
    favicon_url: z.string().optional(),
    palette: BrandPaletteSchema.optional(),
    typography: BrandTypographySchema.optional(),
    logo: BrandLogoSchema.optional(),
    attribution: z.array(BrandAttributionSchema).optional(),
  }),
  network: z.object({ id: z.string(), display_name: z.string().optional() }),
  domains: z.array(AggregatorConfigDomainSchema),
  features: z.object({ custom_roles: z.boolean() }),
  dashboardBuckets: DashboardBucketsSchema.optional(),
  /** Per-link registration modes declared by the network (admin dropdown source). */
  registration_modes: z.record(RegistrationModeConfigSchema).optional(),
  /** Per-domain Signals UI login URLs. A domain without a URL has no Signals hand-off. */
  signals_ui_urls: z.record(z.string()).optional(),
});
export type AggregatorConfigPayload = z.infer<typeof AggregatorConfigPayloadSchema>;

/** Fallback config used while loading and after a failed fetch. */
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
  // Custom roles stay off unless the api turns them on.
  features: { custom_roles: false },
};

export function useAggregatorConfig() {
  const query = useQuery({
    queryKey: ['aggregator-config'],
    queryFn: () => jsonFetch('/api/aggregator-config', AggregatorConfigPayloadSchema),
    // Config rarely changes between deploys.
    staleTime: 5 * 60 * 1000,
  });
  const { error } = query;
  // On failure callers fall back to the default config, which turns off
  // config-gated surfaces. Log it so the failure is visible.
  useEffect(() => {
    if (!error) return;
    console.error(
      '[aggregator-config] fetch failed — falling back to default branding; config-gated surfaces (Signals hand-off, consent gates) will not render',
      {
        operation: 'aggregator-config.fetch',
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ResponseShapeError ? { issues: error.issueSummary() } : {}),
      },
    );
  }, [error]);
  return query;
}
