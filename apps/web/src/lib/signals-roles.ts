/**
 * Which Keycloak realm roles mark a Signals participant.
 *
 * The coordinator portal and the Signals app share one realm, so a token that
 * fails this portal's `aggregator_id` gate may still be a perfectly valid
 * Signals identity. Recognising that positively is what lets the login screen
 * explain the situation rather than guess (#753).
 *
 * **Config as code, not a deployment env var.** The list lives in the active
 * network's `config/<network>[/<brand>]/aggregator.config.yaml` under
 * `aggregator.signals.realm_roles`, read server-side through
 * `@aggregator-dpg/config-loader/fs` — the same way the registration
 * Terms/Privacy copy is read, with no API round-trip (see `apps/web/CLAUDE.md`).
 * That matters for more than tidiness: the `config/` tree ships with this repo
 * and is mounted into the container, so the value reaches a cluster without a
 * chart, values-file or image-pin change. An env-var-only design looked fine
 * locally and would have left the classifier inert everywhere else.
 *
 * `SIGNALS_REALM_ROLES` is still honoured as an **override**, for a local
 * one-off or an incident where config can't be re-rolled.
 *
 * Whatever the source, the list must name the roles Signals actually stamps
 * (its `KEYCLOAK_REQUIRED_REALM_ROLES`). When neither source yields anything
 * the classifier returns `unknown` and the login screen falls back to generic
 * copy — a confidently wrong message would be worse than a vague one.
 *
 * @module apps/web/src/lib/signals-roles
 */

import 'server-only';
import { loadSignalsRealmRoles } from '@aggregator-dpg/config-loader/fs';
import { logger } from './logger';

/** Env var carrying the comma-separated Signals participant roles (override). */
const ENV_KEY = 'SIGNALS_REALM_ROLES';

/**
 * Returns the Signals participant realm roles set by the env override.
 *
 * Module-private: every caller wants {@link resolveSignalsRealmRoles}, which
 * applies the config fallback. Kept as its own function because it is pure —
 * no filesystem, no async — which keeps the precedence logic readable.
 *
 * @param env - Env bag; defaults to `process.env`.
 * @returns Role names, or an empty array when unset.
 */
function envRealmRoles(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[ENV_KEY] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Memoised result. Config is read once per process rather than per request —
 * `.claude/rules/configuration-discipline.md`: never re-read config files
 * inside a request path. `undefined` means "not resolved yet".
 */
let cached: string[] | undefined;

/**
 * Resolves the Signals participant realm roles: env override first, then the
 * active network's config file.
 *
 * Never throws. A config file that exists but cannot be read or parsed is a
 * real fault, so it is logged — but it still degrades to an empty list, which
 * the classifier reports as `unknown`. Failing the login page over a YAML key
 * would be a worse outcome than generic copy.
 *
 * @returns The role names, or an empty array when unconfigured.
 */
export async function resolveSignalsRealmRoles(): Promise<string[]> {
  if (cached !== undefined) return cached;

  const fromEnv = envRealmRoles();
  if (fromEnv.length > 0) {
    cached = fromEnv;
    return cached;
  }

  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  const start = Date.now();
  try {
    cached = await loadSignalsRealmRoles(network, brand, process.env.CONFIG_ROOT?.trim());
  } catch (err) {
    logger.warn({
      operation: 'signalsRealmRoles.loadFromConfig',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
      latency_ms: Date.now() - start,
      network,
      brand,
    });
    cached = [];
  }
  return cached;
}

/**
 * Clears the memoised roles. Test seam only — production reads config once per
 * process by design.
 */
export function resetSignalsRealmRolesCache(): void {
  cached = undefined;
}
