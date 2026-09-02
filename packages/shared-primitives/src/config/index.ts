/**
 * Config primitives shared by the api and worker processes.
 *
 * Each process parses its own Zod `ConfigSchema` from `process.env`, but some
 * fields must be identical across processes — kept here as the single source
 * of truth so the two can't drift: the SignalStack outward-push fields
 * (api-key + Keycloak bearer credential, both call the same signals instance
 * as the same service identity), the D7 TLS-posture guard (same enforcement
 * everywhere), and the campaign export field-set (#617 — the worker performs
 * the export the api-side audit log describes, so a divergent copy would let
 * the audit misreport what actually left the system).
 *
 * @module @aggregator-dpg/shared-primitives/config
 */

import { z } from 'zod';
import { ConfigError } from '../errors/index.js';

/**
 * SignalStack outward-push env fields common to every process that pushes to
 * SignalStack. Spread into a process's `ConfigSchema`. Process-specific extras
 * are declared alongside the spread: `SIGNALSTACK_ACTING_ORG_ID` is api-only
 * (the aggregator-approval flow); `KEYCLOAK_URL`/`KEYCLOAK_REALM` are declared
 * by each process that mints the bearer token.
 */
export const signalStackConfigFields = {
  /** Base URL of the signalstack API. When unset, signalstack push is disabled. */
  SIGNALSTACK_BASE_URL: z.string().url().optional(),
  /** Admin api-key for signalstack onboard. Required when SIGNALSTACK_BASE_URL is set. */
  SIGNALSTACK_ADMIN_KEY: z.string().optional(),
  /** item_network sent on every onboard call. */
  SIGNALSTACK_ITEM_NETWORK: z.string().default('blue_dot'),
  /** Per-request timeout for signalstack onboard calls. */
  SIGNALSTACK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /**
   * Which credential `HttpSignalStackWriter` sends: `apikey` (default) uses the
   * `SIGNALSTACK_ADMIN_KEY` header; `bearer` fetches a Keycloak
   * client-credentials token. Must match across processes — both call the same
   * signals instance as the same service identity.
   */
  SIGNALSTACK_AUTH_MODE: z.enum(['apikey', 'bearer']).default('apikey'),
  /**
   * Confidential Keycloak client id for the bearer credential. Must equal this
   * aggregator's signals `organization.slug` (see `SIGNALSTACK_ORG_SLUG`).
   * Required when `SIGNALSTACK_AUTH_MODE=bearer`.
   */
  SIGNALSTACK_CLIENT_ID: z.string().optional(),
  /** Client secret for `SIGNALSTACK_CLIENT_ID`. Required when `SIGNALSTACK_AUTH_MODE=bearer`. */
  SIGNALSTACK_CLIENT_SECRET: z.string().optional(),
  /**
   * This aggregator's `organization.slug` on the signals side. When set, boot
   * asserts `SIGNALSTACK_CLIENT_ID` equals it. Optional — the check no-ops when
   * unset. Must match across processes.
   */
  SIGNALSTACK_ORG_SLUG: z.string().optional(),
} as const;

/**
 * Campaign export field-set, shared by the api and worker processes (#617).
 *
 * The worker reads `CAMPAIGN_EXPORT_FIELDS` to decide what a campaign export
 * actually releases (`contact` = the three canonical contact fields —
 * name/email/phone — only; `full` = the whole decrypted item_state, variable
 * columns). The api reads the SAME key to record `pii_fields` on the
 * `campaign_pii_audit` `requested` row. Kept here and spread into both
 * `ConfigSchema`s — rather than declared separately in each — so the two
 * processes can never diverge: if they did, the audit log would misreport
 * which PII actually left the system (e.g. worker=`full`, api=`contact` would
 * log `[name,email,phone]` while the export shipped the entire item_state),
 * which defeats the audit's purpose.
 */
export const campaignExportConfigFields = {
  /**
   * `contact` = name/email/phone only; `full` = the whole decrypted
   * item_state (variable columns). Default `contact`.
   */
  CAMPAIGN_EXPORT_FIELDS: z.enum(['contact', 'full']).default('contact'),
} as const;

/** Minimal shape `assertTlsPosture` reads — any process `Config` satisfies it. */
export interface TlsPostureConfig {
  NODE_TLS_REJECT_UNAUTHORIZED?: string | undefined;
  INSTANCE_ENV?: string | undefined;
  NODE_ENV: string;
}

/**
 * Enforces the D7 TLS posture: refuses to start in production (throws) and
 * warns loudly elsewhere when `NODE_TLS_REJECT_UNAUTHORIZED=0` disables all TLS
 * certificate verification. Uses `process.emitWarning` (not the app logger) for
 * the non-fatal path to avoid a config↔logger import cycle at module load.
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When `NODE_TLS_REJECT_UNAUTHORIZED=0` in production.
 */
export function assertTlsPosture(c: TlsPostureConfig): void {
  // Node disables verification only for the exact string '0'.
  if (c.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return;
  const env = c.INSTANCE_ENV ?? c.NODE_ENV;
  const msg = 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables all TLS certificate verification';
  if (env === 'production') {
    throw new ConfigError(`${msg}; refusing to start in production.`, {
      code: 'INSECURE_TLS_IN_PROD',
    });
  }
  process.emitWarning(
    `${msg}. Allowed outside production (env=${env}); never use this on a VM/prod deploy.`,
    { code: 'INSECURE_TLS_POSTURE' },
  );
}

/** Minimal shape `assertSignalStackClientIdentity` reads. */
export interface SignalStackIdentityConfig {
  SIGNALSTACK_AUTH_MODE: 'apikey' | 'bearer';
  SIGNALSTACK_CLIENT_ID?: string | undefined;
  SIGNALSTACK_ORG_SLUG?: string | undefined;
}

/**
 * Fails hard at boot when the bearer service-auth credential cannot resolve to
 * the right Signals organisation.
 *
 * Signals maps the calling client id → `organization.slug` to decide *which*
 * org a service call acts as, so `SIGNALSTACK_CLIENT_ID` must equal this
 * aggregator's slug there. A mismatch is not a login failure — it authenticates
 * fine and then acts as the wrong (or no) org, which is far harder to diagnose
 * than a refused boot. The expected slug is deployment-specific, so it is
 * configuration (`SIGNALSTACK_ORG_SLUG`), not a constant; the check no-ops when
 * unset.
 *
 * Scope note: a *missing* client id is deliberately NOT fatal here — the
 * signalstack factory already treats incomplete bearer config as "push
 * disabled" (a warn, not a crash), and this guard must not turn that into a
 * boot failure. It only rejects a client id that is present and *wrong*.
 *
 * @param c - Parsed runtime config.
 * @throws {ConfigError} When bearer mode is on and client id ≠ expected slug.
 */
export function assertSignalStackClientIdentity(c: SignalStackIdentityConfig): void {
  if (c.SIGNALSTACK_AUTH_MODE !== 'bearer') return;
  if (!c.SIGNALSTACK_CLIENT_ID) return;
  const expected = c.SIGNALSTACK_ORG_SLUG;
  if (expected && c.SIGNALSTACK_CLIENT_ID !== expected) {
    throw new ConfigError(
      `SIGNALSTACK_CLIENT_ID (${c.SIGNALSTACK_CLIENT_ID}) must equal SIGNALSTACK_ORG_SLUG ` +
        `(${expected}) — signals resolves the acting organisation from the client id, so a ` +
        'mismatch would act as the wrong org.',
      { code: 'SIGNALSTACK_CLIENT_ID_MISMATCH' },
    );
  }
}
