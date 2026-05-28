/**
 * Aggregator config read endpoint.
 *
 *   GET /v1/aggregator-config
 *     Returns the public surface of the resolved aggregator + network
 *     config. The web app reads this once on mount and threads the
 *     brand + domain labels + url slug through the sidebar, topbar,
 *     dashboard tabs, and tab counts.
 *
 * No auth required — every value here is operator-controlled and
 * already visible in the page title / sidebar logo / public URL slug.
 * Secrets (signalstack admin key, postgres password) live in env and
 * are intentionally never serialised here.
 *
 * @module apps/api/routes/aggregator-config
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  BrandLogo,
  BrandPalette,
  BrandTypography,
  DashboardBuckets,
  DashboardTiles,
  RegistrationMode,
  StatusRule,
} from '@aggregator-dpg/network-config/interface';
import { getNetworkConfig } from '../services/network-config.js';

/**
 * Public-safe projection of the resolved network config. Excludes
 * raw JSON Schema payloads (the form validator endpoint handles
 * those) and the full upstream `network.json` to keep the wire
 * payload small.
 */
interface PublicAggregatorConfig {
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
  domains: Array<{
    id: string;
    label: string;
    plural_label: string;
    item_type: string;
    dashboardTiles?: DashboardTiles;
    status_rules?: StatusRule[];
  }>;
  dashboardBuckets?: DashboardBuckets;
  /**
   * Per-link registration modes declared by the network. The web admin form
   * renders its mode dropdown from these keys (label + optional public hint).
   */
  registration_modes: Record<string, RegistrationMode>;
}

const AggregatorConfigResponseSchema = z
  .object({
    aggregator: z.object({
      name: z.string(),
      legal_name: z.string().optional(),
      contact_email: z.string().optional(),
    }),
    brand: z
      .object({
        short_name: z.string(),
        long_name: z.string(),
        tagline: z.string().optional(),
        strapline: z.string().optional(),
        url_slug: z.string(),
        primary_color: z.string().optional(),
        accent_color: z.string().optional(),
        logo_url: z.string().optional(),
        favicon_url: z.string().optional(),
      })
      .passthrough(),
    network: z.object({
      id: z.string(),
      display_name: z.string().optional(),
    }),
    domains: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          plural_label: z.string(),
          item_type: z.string(),
        })
        .passthrough(),
    ),
    dashboardBuckets: z
      .object({
        by_status: z.record(z.string(), z.string()).optional(),
        by_action_status: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .optional(),
    registration_modes: z.record(
      z.string(),
      z.object({ label: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();

export async function registerAggregatorConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/aggregator-config',
    {
      schema: {
        tags: ['aggregator-config'],
        summary: 'Public brand + network config',
        description:
          'Brand palette/logo + per-domain labels (tab name, plural, tiles, status_rules) + dashboard bucket labels. Web BFF reads this at boot to theme the portal and render the dashboard config-driven.',
        response: { 200: AggregatorConfigResponseSchema },
      },
    },
    async (_req, reply) => {
      const cfg = await getNetworkConfig();
      const payload: PublicAggregatorConfig = {
        aggregator: {
          name: cfg.aggregator.name,
          ...(cfg.aggregator.legal_name ? { legal_name: cfg.aggregator.legal_name } : {}),
          ...(cfg.aggregator.contact_email ? { contact_email: cfg.aggregator.contact_email } : {}),
        },
        brand: {
          short_name: cfg.aggregator.brand.short_name,
          long_name: cfg.aggregator.brand.long_name,
          ...(cfg.aggregator.brand.tagline ? { tagline: cfg.aggregator.brand.tagline } : {}),
          ...(cfg.aggregator.brand.strapline ? { strapline: cfg.aggregator.brand.strapline } : {}),
          url_slug: cfg.aggregator.brand.url_slug,
          ...(cfg.aggregator.brand.primary_color
            ? { primary_color: cfg.aggregator.brand.primary_color }
            : {}),
          ...(cfg.aggregator.brand.accent_color
            ? { accent_color: cfg.aggregator.brand.accent_color }
            : {}),
          ...(cfg.aggregator.brand.logo_url ? { logo_url: cfg.aggregator.brand.logo_url } : {}),
          ...(cfg.aggregator.brand.favicon_url
            ? { favicon_url: cfg.aggregator.brand.favicon_url }
            : {}),
          ...(cfg.aggregator.brand.palette ? { palette: cfg.aggregator.brand.palette } : {}),
          ...(cfg.aggregator.brand.typography
            ? { typography: cfg.aggregator.brand.typography }
            : {}),
          ...(cfg.aggregator.brand.logo ? { logo: cfg.aggregator.brand.logo } : {}),
        },
        network: {
          id: cfg.network.id,
          ...(cfg.network.display_name ? { display_name: cfg.network.display_name } : {}),
        },
        domains: cfg.domainIds.map((id) => {
          const d = cfg.domains[id]!;
          return {
            id: d.id,
            label: d.label,
            plural_label: d.pluralLabel,
            item_type: d.itemType,
            ...(d.dashboardTiles ? { dashboardTiles: d.dashboardTiles } : {}),
            ...(d.statusRules ? { status_rules: d.statusRules } : {}),
          };
        }),
        ...(cfg.dashboardBuckets ? { dashboardBuckets: cfg.dashboardBuckets } : {}),
        registration_modes: cfg.aggregator.registration_modes ?? {},
      };
      return reply.header('Cache-Control', 'public, max-age=60').send(payload);
    },
  );
}
