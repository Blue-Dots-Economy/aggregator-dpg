/**
 * Network-config contract.
 *
 * The aggregator is a generic platform that runs against ANY signalstack
 * network (blue_dot, purple_dot, yellow_dot, ...). A single
 * `aggregator.config.yaml` per deployment plus a reference to the
 * upstream signalstack `network.json` is everything the operator needs
 * to spin up a new aggregator. No hardcoded domain ids, item types, or
 * schema field names anywhere in business logic.
 *
 * This module owns the shape; concrete loading happens in {@link
 * NetworkConfigLoader} implementations (file + http for production,
 * static-injection for tests).
 *
 * @module @aggregator-dpg/network-config/interface
 */

import { z } from 'zod';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

// ─── Aggregator YAML schema ──────────────────────────────────────────────────

/**
 * Per-domain identity selectors. Bridge the schema's field names to the
 * canonical `name / phone / email` the aggregator uses for dedup, KC
 * linking, signalstack user payload. Optional — the sniffer derives
 * sensible defaults from the schema when this section is absent.
 */
export const IdentitySelectorsSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().min(1),
});
export type IdentitySelectors = z.infer<typeof IdentitySelectorsSchema>;

/**
 * Optional UI labels for a single signalstack domain. Falls back to
 * the domain id from network.json when unset.
 */
export const DomainLabelsSchema = z.object({
  singular: z.string().optional(),
  plural: z.string().optional(),
  tab_label: z.string().optional(),
});
export type DomainLabels = z.infer<typeof DomainLabelsSchema>;

/**
 * Brand / UI surface — sidebar/topbar/email templates read from here.
 */
export const BrandConfigSchema = z.object({
  short_name: z.string().min(1),
  long_name: z.string().min(1),
  tagline: z.string().optional(),
  url_slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'url_slug must be kebab-case alphanumeric'),
  primary_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'primary_color must be #RRGGBB')
    .optional(),
  accent_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'accent_color must be #RRGGBB')
    .optional(),
  logo_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

/**
 * Network binding — where to fetch the signalstack `network.json` and
 * how to bridge it to the aggregator's identity model.
 */
export const NetworkBindingSchema = z.object({
  source: z.string().url(),
  field_overrides: z.record(z.string(), IdentitySelectorsSchema).optional(),
  csv_array_delimiter: z.string().min(1).default('|'),
});
export type NetworkBinding = z.infer<typeof NetworkBindingSchema>;

/**
 * Onboarding behaviour toggles.
 */
export const OnboardingConfigSchema = z.object({
  presume_consent: z.boolean().default(true),
  bulk_max_rows: z.coerce.number().int().positive().default(10000),
});
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>;

/**
 * Root aggregator config — the YAML the operator edits per deployment.
 */
export const AggregatorYamlSchema = z.object({
  aggregator: z.object({
    name: z.string().min(1),
    legal_name: z.string().optional(),
    contact_email: z.string().email().optional(),
    network: NetworkBindingSchema,
    brand: BrandConfigSchema,
    domain_labels: z.record(z.string(), DomainLabelsSchema).optional(),
    onboarding: OnboardingConfigSchema.default({}),
    admin_emails: z.array(z.string().email()).default([]),
  }),
});
export type AggregatorYaml = z.infer<typeof AggregatorYamlSchema>;

// ─── Signalstack network.json (the subset the aggregator cares about) ────────

/**
 * One domain inside a signalstack network. Carries the JSON Schemas
 * keyed by `item_type` — the aggregator looks up the active schema by
 * `(domain_id, item_type)`.
 */
export interface NetworkDomain {
  id: string;
  description?: string;
  item_schemas: Record<string, Record<string, unknown>>;
}

/**
 * Parsed signalstack `network.json`. Captured verbatim — the aggregator
 * only reads `id`, `domains`, and `display_name`; the rest passes
 * through unchanged so future surfaces (the `actions` workflow) can
 * consume the same singleton.
 */
export interface SignalstackNetwork {
  id: string;
  display_name?: string;
  description?: string;
  domains: NetworkDomain[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}

// ─── Resolved config (what callers read) ─────────────────────────────────────

/**
 * One domain after merging signalstack's network.json with the
 * aggregator's overlay. Used everywhere a route or worker needs to
 * decide "what item_type, what schema, what name field?" for a given
 * participant kind.
 */
export interface ResolvedDomain {
  id: string;
  /** Display label — falls back to a title-cased id when unset. */
  label: string;
  /** Plural label for tab + sidebar text. */
  pluralLabel: string;
  /** Default item type for this domain (first key of `item_schemas`). */
  itemType: string;
  /** JSON Schema for the default item type. */
  schema: Record<string, unknown>;
  /** Identity selectors (sniffer-derived, overridden by config). */
  identity: IdentitySelectors;
}

/**
 * Fully-resolved configuration the aggregator runs against. Built once
 * at boot; treated as immutable thereafter. Tests inject a stub via
 * the {@link NetworkConfigStore}.
 */
export interface ResolvedNetworkConfig {
  aggregator: AggregatorYaml['aggregator'];
  network: SignalstackNetwork;
  domains: Record<string, ResolvedDomain>;
  /** Domain ids in declaration order — preserves UI tab ordering. */
  domainIds: string[];
}

// ─── Loader port ─────────────────────────────────────────────────────────────

export type NetworkConfigError =
  | { code: 'CONFIG_FILE_MISSING'; message: string }
  | { code: 'CONFIG_PARSE_FAILED'; message: string; cause?: Error }
  | { code: 'NETWORK_FETCH_FAILED'; message: string; cause?: Error }
  | { code: 'NETWORK_PARSE_FAILED'; message: string; cause?: Error }
  | { code: 'DOMAIN_RESOLUTION_FAILED'; message: string };

/**
 * Persistence port for the aggregator config loader.
 *
 * Concrete impls:
 *   - {@link FileNetworkConfigLoader} reads YAML from disk + fetches
 *     signalstack network.json over HTTPS with a last-known-good cache.
 *   - {@link InMemoryNetworkConfigLoader} returns a pinned config —
 *     tests use this to bypass the file/HTTP layer entirely.
 *
 * Returns `Result<T, NetworkConfigError>` — never throws.
 */
export abstract class NetworkConfigLoaderBase {
  /**
   * Loads + resolves the active config. Idempotent across calls in the
   * same process: the second call returns the cached singleton without
   * re-fetching signalstack.
   */
  abstract load(): Promise<Result<ResolvedNetworkConfig, BaseError | NetworkConfigError>>;
}
