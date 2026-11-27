/**
 * Server-side read of the aggregator's deploy-time capability flags.
 *
 * Flags come from `GET /v1/aggregator-config` (`features.custom_roles`,
 * `features.owner_self_add`). The console layout, roles page, role-mutation BFF
 * routes, team pages and organisation registration read them here. Fails safe
 * to `false` and `owner`, so an api problem hides the admin screens and keeps
 * the console's "Add myself to My Team" step.
 *
 * @module apps/web/src/lib/features.server
 */

import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import {
  OwnerSelfAddModeSchema,
  type OwnerSelfAddMode,
} from '@aggregator-dpg/shared-primitives/user-org';
import { logger } from './logger';

/** Deploy-time capability flags surfaced by `GET /v1/aggregator-config`. */
export interface AggregatorFeatures {
  custom_roles: boolean;
  /** How an organisation owner joins their own team (`OWNER_SELF_ADD_MODE`). */
  owner_self_add: OwnerSelfAddMode;
  /** The role an invited organisation is shown with; `null` when the api does not say. */
  invite_role_label: string | null;
}

const FETCH_TIMEOUT_MS = 5000;

/** Fail-safe default when the api is unreachable or omits the field. */
const DEFAULT_FEATURES: AggregatorFeatures = {
  custom_roles: false,
  owner_self_add: 'owner',
  invite_role_label: null,
};

/** The `features` block of `/v1/aggregator-config`. A missing flag is off. */
const FeaturesConfigSchema = z.object({
  features: z
    .object({
      custom_roles: z.boolean().optional(),
      // An unknown value reads as the default, so one new mode cannot turn every flag off.
      owner_self_add: OwnerSelfAddModeSchema.optional().catch(undefined),
    })
    .optional(),
  // Another shape reads as no label, so the console falls back to its own.
  organisation: z.object({ invite_role_label: z.string().optional() }).optional().catch(undefined),
});

/**
 * Logs a warning without ever throwing.
 *
 * The logger's transport worker can exit under the dev server and make
 * `logger.warn` throw; the fail-safe return must still happen.
 *
 * @param payload - Structured log fields.
 */
function warnSafe(payload: Record<string, unknown>): void {
  try {
    logger.warn(payload);
  } catch {
    /* logging must never break the request */
  }
}

/**
 * Reads the deploy-time capability flags from the aggregator api.
 *
 * On any failure returns {@link DEFAULT_FEATURES} (everything off). Never
 * throws. Wrapped in React's `cache()`, so one request makes one upstream call.
 *
 * @returns The resolved feature flags, or the fail-safe default.
 */
export const getAggregatorFeatures = cache(
  async function getAggregatorFeatures(): Promise<AggregatorFeatures> {
    const base = process.env.API_BASE_URL ?? 'http://localhost:4000';
    const start = Date.now();
    try {
      const res = await fetch(`${base}/v1/aggregator-config`, {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        warnSafe({
          operation: 'features.getAggregatorFeatures',
          status: 'failure',
          error: `HTTP ${res.status}`,
          latency_ms: Date.now() - start,
        });
        return DEFAULT_FEATURES;
      }
      const cfg = FeaturesConfigSchema.safeParse(await res.json());
      if (!cfg.success) {
        warnSafe({
          operation: 'features.getAggregatorFeatures',
          status: 'failure',
          error: 'unexpected response shape',
          latency_ms: Date.now() - start,
        });
        return DEFAULT_FEATURES;
      }
      const label = cfg.data.organisation?.invite_role_label;
      return {
        custom_roles: cfg.data.features?.custom_roles === true,
        owner_self_add: cfg.data.features?.owner_self_add ?? DEFAULT_FEATURES.owner_self_add,
        invite_role_label: label || null,
      };
    } catch (err) {
      warnSafe({
        operation: 'features.getAggregatorFeatures',
        status: 'failure',
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      });
      return DEFAULT_FEATURES;
    }
  },
);

/**
 * Whether the custom-roles capability is enabled for this deployment.
 *
 * @returns True when the api reports `features.custom_roles === true`.
 */
export async function customRolesEnabled(): Promise<boolean> {
  return (await getAggregatorFeatures()).custom_roles;
}

/**
 * How an organisation owner joins their own team on this deployment.
 *
 * @returns `features.owner_self_add`, or `owner` when the api does not say.
 */
export async function ownerSelfAddMode(): Promise<OwnerSelfAddMode> {
  return (await getAggregatorFeatures()).owner_self_add;
}
