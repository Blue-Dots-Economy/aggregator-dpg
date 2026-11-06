/**
 * Public config routes of the api app.
 *
 *   GET /v1/aggregator-config
 *     Returns the public part of the aggregator and network config. The web
 *     app reads it to render brand, domain labels and dashboard settings.
 *
 * No auth: every value is already public. Secrets are never included.
 *
 * @module apps/api/routes/aggregator-config
 */

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  BrandAttributionSchema,
  BrandLogoSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  DashboardTileDefSchema,
  DashboardTilesSchema,
  RegistrationModeSchema,
  StatusRuleSchema,
} from '@aggregator-dpg/network-config/interface';
import { errorResponses } from '../errors/openapi.js';
import { getNetworkConfig } from '../services/network-config.js';
import { config, enabledRegistrationModes, signalsUiUrls } from '../config.js';
import { signalsCtaEnabled } from '../services/registration-mode/index.js';

// The tile and status-rule schemas come from network-config, which keeps unknown
// keys. The reply strips them, so it carries only the documented fields.

/** Profile and user tile groups for one domain's dashboard. */
const DashboardTilesReplySchema = DashboardTilesSchema.extend({
  profile: z.array(DashboardTileDefSchema.strip()).optional(),
  user: z.array(DashboardTileDefSchema.strip()).optional(),
}).strip();

/**
 * Bucket labels keyed by Signals value.
 *
 * Open to any key, so a status the web does not know yet still reaches it.
 */
const BucketLabelsSchema = z.record(z.string(), z.string());

/** Network-wide label overrides for the dashboard status and action buckets. */
const DashboardBucketsReplySchema = z.object({
  by_status: BucketLabelsSchema.optional(),
  by_initiated_action_status: BucketLabelsSchema.optional(),
  by_received_action_status: BucketLabelsSchema.optional(),
});

/**
 * Public part of the resolved network config. Leaves out JSON Schemas and the full `network.json`.
 *
 * Fastify validates and serialises the reply with this schema, so a key it does
 * not declare is dropped from the reply.
 */
const AggregatorConfigResponseSchema = z.object({
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
    /** Sent only when the brand declares `attribution`. */
    attribution: z.array(BrandAttributionSchema).optional(),
  }),
  network: z.object({
    id: z.string(),
    display_name: z.string().optional(),
  }),
  domains: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      plural_label: z.string(),
      item_type: z.string(),
      /** From network.json; drives the registration birth-year field. */
      guardian_consent_required: z.boolean(),
      /** From network.json; drives the registration consent step. */
      go_live_required: z.array(z.string()),
      dashboardTiles: DashboardTilesReplySchema.optional(),
      status_rules: z.array(StatusRuleSchema.strip()).optional(),
    }),
  ),
  dashboardBuckets: DashboardBucketsReplySchema.optional(),
  /** Registration modes this deployment offers; the create-link dropdown uses these keys. */
  registration_modes: z.record(
    z.string(),
    RegistrationModeSchema.extend({ signals_cta: z.boolean() }),
  ),
  /**
   * Per-domain Signals UI login URLs from `SIGNALS_UI_URLS`. Empty when unset.
   *
   * Checked at boot with `new URL()`. A plain string here, since `z.string().url()`
   * could reject a value that boot accepted and cause a 500.
   */
  signals_ui_urls: z.record(z.string(), z.string()),
  /** Feature flags, always present. `custom_roles` is `RBAC_CUSTOM_ROLES_ENABLED`. */
  features: z.object({ custom_roles: z.boolean() }),
});

/** Wire shape of `GET /v1/aggregator-config`. */
type PublicAggregatorConfig = z.infer<typeof AggregatorConfigResponseSchema>;

export async function registerAggregatorConfigRoutes(base: FastifyInstance): Promise<void> {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.get(
    '/v1/aggregator-config',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['aggregator-config'],
        summary: 'Public brand + network config',
        description:
          'Brand palette/logo + per-domain labels (tab name, plural, tiles, status_rules) + dashboard bucket labels. Web BFF reads this at boot to theme the portal and render the dashboard config-driven.',
        response: { 200: AggregatorConfigResponseSchema, ...errorResponses(500, 503) },
      },
    },
    async (_req, reply) => {
      const cfg = await getNetworkConfig();
      // Same helper as the create-link check, so the dropdown matches what creation accepts.
      const enabledModes = new Set(
        enabledRegistrationModes(Object.keys(cfg.aggregator.registration_modes ?? {})),
      );
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
          ...(cfg.aggregator.brand.attribution?.length
            ? { attribution: cfg.aggregator.brand.attribution }
            : {}),
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
            guardian_consent_required: d.guardianConsentRequired,
            go_live_required: d.goLiveRequired,
            ...(d.dashboardTiles ? { dashboardTiles: d.dashboardTiles } : {}),
            ...(d.statusRules ? { status_rules: d.statusRules } : {}),
          };
        }),
        ...(cfg.dashboardBuckets ? { dashboardBuckets: cfg.dashboardBuckets } : {}),
        registration_modes: Object.fromEntries(
          Object.entries(cfg.aggregator.registration_modes ?? {})
            // Drop modes withheld by `AGGREGATOR_ONBOARDING_ENABLED`.
            .filter(([key]) => enabledModes.has(key))
            .map(([key, mode]) => [
              key,
              // Resolve the `signals_cta` default with the rule shared with the web app.
              { ...mode, signals_cta: signalsCtaEnabled(key, cfg) },
            ]),
        ),
        signals_ui_urls: signalsUiUrls,
        features: { custom_roles: config.RBAC_CUSTOM_ROLES_ENABLED },
      };
      return reply.header('Cache-Control', 'public, max-age=60').send(payload);
    },
  );

  app.get(
    '/v1/participant-consent',
    {
      config: { rbac: { access: 'public' } },
      schema: {
        tags: ['aggregator-config'],
        summary: 'Participant registration-link consent document',
        description:
          'The participant `consent.json` (Terms / Privacy / profile-creation) fetched from `aggregator.network.consent_source` — the same cache-backed pull as network.json. `participant_consent` is null when no `consent_source` is configured (the web app then falls back to its on-disk copy). No auth — operator-controlled content shown on the public registration form.',
        response: {
          200: z
            .object({ participant_consent: z.record(z.string(), z.unknown()).nullable() })
            .passthrough(),
          ...errorResponses(500, 503),
        },
      },
    },
    async (_req, reply) => {
      const cfg = await getNetworkConfig();
      return reply
        .header('Cache-Control', 'public, max-age=60')
        .send({ participant_consent: cfg.participantConsent ?? null });
    },
  );
}
