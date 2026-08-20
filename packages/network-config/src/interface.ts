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
  // Email is optional — some domain schemas (e.g. orange_dot tourist)
  // have no email field. Dedup falls back to phone-only when absent.
  email: z.string().min(1).optional(),
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
 * Hex colour `#RRGGBB`. Lower or upper case accepted.
 */
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be #RRGGBB');

/**
 * Named palette swatch (`{ name, hex }`). Sourced from `brand.json`.
 */
export const PaletteSwatchSchema = z.object({
  name: z.string().min(1),
  hex: HexColorSchema,
});
export type PaletteSwatch = z.infer<typeof PaletteSwatchSchema>;

/**
 * Named gradient (`{ name, from, to }`). Sourced from `brand.json`.
 */
export const GradientSchema = z.object({
  name: z.string().min(1),
  from: HexColorSchema,
  to: HexColorSchema,
});
export type Gradient = z.infer<typeof GradientSchema>;

/**
 * Full design-token palette loaded from a sibling `brand.json`.
 * All groups are optional so the loader degrades cleanly when the
 * file is absent.
 */
export const BrandPaletteSchema = z.object({
  primary: z.array(PaletteSwatchSchema).optional(),
  secondary: z.array(PaletteSwatchSchema).optional(),
  accent: z.array(PaletteSwatchSchema).optional(),
  gradients: z.array(GradientSchema).optional(),
});
export type BrandPalette = z.infer<typeof BrandPaletteSchema>;

/**
 * Single typography face (heading or body) — family + weight + an
 * optional sample copy block lifted directly from `brand.json`.
 */
export const BrandTypographyFaceSchema = z.object({
  family: z.string().min(1),
  weight: z.string().min(1),
  sampleCopy: z.string().optional(),
});
export type BrandTypographyFace = z.infer<typeof BrandTypographyFaceSchema>;

/**
 * Typography tokens loaded from `brand.json`. `primaryFont` drives the
 * default CSS font stack; `headings` / `body` override per face when
 * the design system differentiates them.
 */
export const BrandTypographySchema = z.object({
  primaryFont: z.string().min(1),
  headings: BrandTypographyFaceSchema.optional(),
  body: BrandTypographyFaceSchema.optional(),
});
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

/**
 * Logo variant paths. Values are absolute web paths under
 * `apps/web/public/` (e.g. `/brand/blue-dot/logo.png`) or fully
 * qualified URLs.
 */
export const BrandLogoSchema = z.object({
  default: z.string().min(1).optional(),
  light: z.string().min(1).optional(),
  withStrapline: z.string().min(1).optional(),
  withStraplineLight: z.string().min(1).optional(),
  onBrand: z.string().min(1).optional(),
});
export type BrandLogo = z.infer<typeof BrandLogoSchema>;

/**
 * Brand / UI surface — sidebar/topbar/email templates read from here.
 *
 * The flat fields (`short_name`, `primary_color`, ...) are the
 * authoritative deploy-state values from `aggregator.config.yaml`.
 * `palette`, `typography` and `logo` come from the sibling
 * `brand.json` design-system file when present, and are merged in by
 * the loader before validation.
 */
export const BrandConfigSchema = z.object({
  short_name: z.string().min(1),
  long_name: z.string().min(1),
  tagline: z.string().optional(),
  url_slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'url_slug must be kebab-case alphanumeric'),
  primary_color: HexColorSchema.optional(),
  accent_color: HexColorSchema.optional(),
  logo_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
  palette: BrandPaletteSchema.optional(),
  typography: BrandTypographySchema.optional(),
  logo: BrandLogoSchema.optional(),
  strapline: z.string().optional(),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

/**
 * Network binding — where to fetch the signalstack `network.json` and
 * how to bridge it to the aggregator's identity model.
 */
export const NetworkBindingSchema = z.object({
  /**
   * URL of the upstream signalstack `network.json`. Optional in the YAML
   * because a deployment may provide it via the `AGGREGATOR_NETWORK_SOURCE`
   * env override instead (#512); the loader fails `load()` when neither is
   * set.
   */
  source: z.string().url().optional(),
  field_overrides: z.record(z.string(), IdentitySelectorsSchema).optional(),
  csv_array_delimiter: z.string().min(1).default('|'),
});
export type NetworkBinding = z.infer<typeof NetworkBindingSchema>;

/**
 * Onboarding behaviour toggles.
 *
 * `presume_consent` governs the BULK-UPLOAD path only (`bulk-row-process.ts`);
 * the interactive registration-link flow always captures consent from the
 * participant. When true, an adult bulk row is forwarded to Signals with
 * `user_terms` / `user_privacy` / `profile_creation` all asserted on the
 * participant's behalf, which satisfies the `consent_required` go-live gate and
 * publishes the profile immediately. Minors are never presumed
 * (`!rowIsMinor`). When false, `compliance` is omitted entirely and rows land
 * as `draft` until the participant accepts for themselves.
 *
 * Defaults to **false**: presuming consent is a deliberate, per-network policy
 * decision, so it must be opted into explicitly rather than inherited.
 */
export const OnboardingConfigSchema = z.object({
  presume_consent: z.boolean().default(false),
  bulk_max_rows: z.coerce.number().int().positive().default(10000),
});
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>;

/**
 * Validated key for a registration mode entry. Must be a snake_case
 * identifier starting with a lowercase letter.
 */
const RegistrationModeKey = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * One entry in the per-network `registration_modes` config block.
 * Maps an admin-facing channel name (e.g. `voice`, `form`) to a
 * rendering shape and an optional public hint.
 */
export const RegistrationModeSchema = z.object({
  label_i18n_key: z.string().min(1),
  submission_shape: z.enum(['account_only', 'account_and_profile']),
  public_hint_i18n_key: z.string().min(1).nullable(),
  /**
   * Whether links in this mode offer the Signals UI hand-off: today the
   * pre-submit "Already Registered — Sign In" CTA on the public registration
   * page. Once #635 lands it will gate that mode's post-submit redirect too.
   *
   * Optional. When omitted it resolves to
   * `submission_shape === 'account_and_profile'`, so with no config at all the
   * hand-off appears on the full-profile form only. Set explicitly to override
   * per mode — including for modes that do not exist yet.
   */
  signals_cta: z.boolean().optional(),
});
export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;

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
    registration_modes: z.record(RegistrationModeKey, RegistrationModeSchema).default({
      form: {
        label_i18n_key: 'registration_mode.form.label',
        submission_shape: 'account_and_profile',
        public_hint_i18n_key: null,
      },
    }),
  }),
});
export type AggregatorYaml = z.infer<typeof AggregatorYamlSchema>;

/**
 * Alias for `AggregatorYamlSchema`. Exported under both names so tests
 * and future refactors can reference the schema by its logical concept
 * ("config") rather than the serialisation format ("yaml").
 */
export const AggregatorConfigSchema = AggregatorYamlSchema;

// ─── Signalstack network.json (the subset the aggregator cares about) ────────

/**
 * One dashboard tile: which rollup key to read and what to call it. `field`
 * is a key on the signalstack rollup (e.g. `total_users`, `complete_profiles`).
 * The aggregator reads the precomputed value — it never aggregates. Unknown
 * `field` → tile skipped (logged `warn`).
 */
export interface DashboardTileDef {
  field: string;
  label: string;
}

/**
 * Per-domain dashboard tiles, split into profile-level and user-level groups.
 * Both optional — UI falls back to default English tiles when a group is
 * absent. `profile_title` / `user_title` override the group headings
 * ("Profiles" / "Users" eyebrows); the UI falls back to localised
 * defaults when unset. Carried verbatim from `network.json`.
 */
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
  profile_title?: string;
  user_title?: string;
}

/**
 * Network-wide canonical-bucket label overrides. Keys are the fixed Signals
 * vocab; values are the network's preferred copy ("Applied" vs "Requested",
 * etc.). Action labels are split by direction (initiated vs received).
 * Optional throughout — UI defaults to English labels when missing.
 */
export interface DashboardBuckets {
  by_status?: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', string>>;
  by_initiated_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
  by_received_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
}

/**
 * One entry of a domain's `status_rules` array from network.json. `when`
 * is the condition DSL the metrics service evaluates — passed through
 * verbatim. `label`/`description` are optional UI copy the dashboard
 * renders on the status cards (e.g. "New" / "Last 7 days").
 */
export interface StatusRule {
  status: string;
  label?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  when?: any;
}

/**
 * One domain inside a signalstack network. Carries the JSON Schemas
 * keyed by `item_type` — the aggregator looks up the active schema by
 * `(domain_id, item_type)`.
 */
export interface NetworkDomain {
  id: string;
  description?: string;
  /** Per-domain dashboard tile groups (profile + user). Optional passthrough from network.json. */
  dashboard_tiles?: DashboardTiles;
  /** Per-domain status taxonomy + UI copy. Optional passthrough from network.json. */
  status_rules?: StatusRule[];
  /**
   * Signalstack U18 flag: when true, minors in this domain route through a
   * guardian-consent flow, so the registration form must collect a birth year
   * to determine minor status. Absent ⇒ treated as `false` (no DOB collected).
   */
  guardian_consent_required?: boolean;
  /**
   * Signalstack go-live gate tokens for this domain (e.g. `schema_required`,
   * `consent_required`). Drives whether the registration form shows the
   * profile-creation consent step. Absent ⇒ treated as `[]` (no consent step).
   */
  go_live_required?: string[];
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
  /** Shared bucket labels for the dashboard. Optional passthrough from network.json. */
  dashboard_buckets?: DashboardBuckets;
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
  /**
   * Resolved per-domain dashboard tile groups — copy-through from
   * `network.dashboard_tiles` on this domain. UI falls back to generic
   * defaults when undefined.
   */
  dashboardTiles?: DashboardTiles;
  /**
   * Per-domain status rules (copy-through from `network.status_rules` on
   * this domain). Drives the dashboard status-card labels + descriptions.
   */
  statusRules?: StatusRule[];
  /**
   * True when this domain requires guardian consent for minors (mirrors
   * network.json `guardian_consent_required`). When true the registration
   * form collects a birth year; defaults to `false` when absent upstream.
   */
  guardianConsentRequired: boolean;
  /**
   * Go-live gate tokens for this domain (mirrors network.json
   * `go_live_required`). The registration form shows the profile-creation
   * consent step iff this includes `consent_required`; defaults to `[]`.
   */
  goLiveRequired: string[];
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
  /**
   * Convenience extract of `network.dashboard_buckets` so callers don't
   * have to dive into the raw network object. Undefined when the loaded
   * network.json doesn't declare the block.
   */
  dashboardBuckets?: DashboardBuckets;
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

// ─── Registration-form gate predicates (reusable) ────────────────────────────

/**
 * Go-live gate token that, when present in a domain's `go_live_required`,
 * means a profile needs profile-creation consent before it can go live.
 * The single source of truth for the token string across api + web.
 */
export const CONSENT_REQUIRED_GATE = 'consent_required';

/**
 * Whether the registration form should show the profile-creation consent step
 * for a domain. True iff the domain's go-live gates include
 * {@link CONSENT_REQUIRED_GATE}. Absent/empty gates ⇒ false (no consent step).
 *
 * @param goLiveRequired - The domain's resolved `goLiveRequired` tokens.
 * @returns True when a consent step is required.
 */
export function domainRequiresConsent(goLiveRequired: readonly string[] | undefined): boolean {
  return (goLiveRequired ?? []).includes(CONSENT_REQUIRED_GATE);
}

/**
 * Whether the registration form should collect a birth year for a domain.
 * True iff the domain requires guardian consent (U18). Absent ⇒ false.
 *
 * @param guardianConsentRequired - The domain's resolved flag.
 * @returns True when a birth year must be collected.
 */
export function domainRequiresBirthYear(guardianConsentRequired: boolean | undefined): boolean {
  return guardianConsentRequired === true;
}
