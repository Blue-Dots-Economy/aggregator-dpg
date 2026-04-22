/**
 * Zod schema and TypeScript types for config/features.yaml.
 *
 * Controls feature flags (beta gates, post-MVP staging) and locale settings.
 * Boolean flags can be toggled via YAML without code changes.
 * Consumed by apps/api and apps/web via config-loader's slice() accessor.
 *
 * @module @aggregator-dpg/schema-service/features
 */

import { z } from 'zod';

/**
 * Boolean feature flags — each key gates a feature across the platform.
 * Set to false to disable without a code change.
 */
export const FeatureFlagsSchema = z.object({
  /** Gates the bulk CSV onboarding flow. */
  bulkOnboarding: z.boolean(),
  /** Gates the QR-code onboarding flow. */
  qrOnboarding: z.boolean(),
  /** Gates the shareable-link onboarding flow. */
  linkOnboarding: z.boolean(),
  /** Post-MVP: shows profile completeness indicator to participants. */
  betaProfileCompletion: z.boolean(),
});

/**
 * Locale settings — default UI language and the full set of supported locales.
 */
export const LocaleConfigSchema = z.object({
  /** BCP-47 language tag used when the user has no explicit preference. */
  default: z.string().min(2),
  /** Ordered list of BCP-47 tags the platform supports. Must include default. */
  available: z.array(z.string().min(2)).min(1),
});

/**
 * Top-level shape of config/features.yaml.
 */
export const FeaturesConfigSchema = z.object({
  flags: FeatureFlagsSchema,
  locale: LocaleConfigSchema,
});

export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export type LocaleConfig = z.infer<typeof LocaleConfigSchema>;
export type FeaturesConfig = z.infer<typeof FeaturesConfigSchema>;

/**
 * Top-level key under which this config lives in the merged config tree.
 */
export const configKey = 'features';

/**
 * Zod schema that validates config/features.yaml.
 * Discovered and applied by config-loader at boot.
 */
export const configSchema = FeaturesConfigSchema;

/**
 * Baseline features config — reflects config/features.yaml defaults.
 * Merged into the config tree before env overrides.
 */
export const configDefaults: FeaturesConfig = {
  flags: {
    bulkOnboarding: true,
    qrOnboarding: true,
    linkOnboarding: true,
    betaProfileCompletion: false,
  },
  locale: {
    default: 'en',
    available: ['en', 'hi', 'kn', 'te', 'ta'],
  },
};

export type Config = FeaturesConfig;
