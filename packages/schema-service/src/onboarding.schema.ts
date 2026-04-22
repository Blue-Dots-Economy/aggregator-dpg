/**
 * Zod schema and TypeScript types for config/onboarding.yaml.
 *
 * Controls which onboarding modes are active and their per-mode settings.
 * Disabling a mode hides the corresponding UI path and disables its API endpoint.
 *
 * @module @aggregator-dpg/schema-service/onboarding
 */

import { z } from 'zod';

/** Settings shared by every onboarding mode. */
const OnboardingModeBaseSchema = z.object({
  /** When false, the UI path is hidden and the endpoint returns 404. */
  enabled: z.boolean(),
});

/** Bulk CSV upload mode settings. */
export const BulkModeSchema = OnboardingModeBaseSchema.extend({
  /** Repo-root-relative path to the CSV template operators share with participants. */
  csvTemplate: z.string().min(1),
});

/** QR code onboarding mode settings. */
export const QrModeSchema = OnboardingModeBaseSchema.extend({
  /** Rendered QR image size in pixels (width = height). Must be a positive integer. */
  size: z.number().int().positive(),
});

/** Shareable link onboarding mode settings. */
export const LinkModeSchema = OnboardingModeBaseSchema.extend({
  /** Seconds a generated link remains valid before expiring. Must be a positive integer. */
  ttlSeconds: z.number().int().positive(),
});

/**
 * Top-level shape of config/onboarding.yaml.
 */
export const OnboardingConfigSchema = z.object({
  modes: z.object({
    bulk: BulkModeSchema,
    qr: QrModeSchema,
    link: LinkModeSchema,
  }),
});

export type BulkMode = z.infer<typeof BulkModeSchema>;
export type QrMode = z.infer<typeof QrModeSchema>;
export type LinkMode = z.infer<typeof LinkModeSchema>;
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>;
