/**
 * Runtime configuration schema for this package.
 *
 * Parsed and validated at startup via @aggregator-dpg/config-loader
 * (wired once that package is available). Add your service's config
 * keys here as Zod fields.
 *
 * @module @aggregator-dpg/_template/config
 */

import { z } from 'zod';

// Replace with real config fields for your service.
export const configSchema = z.object({
  // exampleTimeoutMs: z.number().int().positive().default(5000),
  // exampleBaseUrl: z.string().url(),
});

export type Config = z.infer<typeof configSchema>;
