/**
 * Process-local singleton for the resolved aggregator + signalstack
 * network config. Loaded once on first access from
 * `AGGREGATOR_CONFIG_PATH` (default `/app/config/aggregator.config.yaml`)
 * and re-used by every route + service that needs to look up a domain's
 * identity selectors, item_type, brand label, etc.
 *
 * Tests inject a pinned config via `_setNetworkConfig`.
 *
 * @module apps/api/services/network-config
 */

import path from 'node:path';
import { FileNetworkConfigLoader } from '@aggregator-dpg/network-config/loader';
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import { resolveConfigPath } from '@aggregator-dpg/network-config/paths';
import { logger } from '../logger.js';
import {
  signalsUiUrls,
  unknownSignalsUiUrlDomains,
  onboardingEnabledCapabilities,
  unknownOnboardingCapabilities,
} from '../config.js';

let cached: ResolvedNetworkConfig | null = null;
let inflight: Promise<ResolvedNetworkConfig> | null = null;

/**
 * Returns the resolved aggregator config. First call triggers the file
 * read + signalstack network.json fetch; subsequent calls return the
 * cached singleton. Throws on any unrecoverable failure so the api
 * fails loud at the route-binding stage instead of swallowing
 * configuration errors at request time.
 */
export async function getNetworkConfig(): Promise<ResolvedNetworkConfig> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const configPath = resolveConfigPath();
    const cacheDir =
      process.env.NETWORK_CONFIG_CACHE_DIR ?? path.join(path.dirname(configPath), '.cache');
    const loader = new FileNetworkConfigLoader({ configPath, cacheDir });
    const result = await loader.load();
    if (!result.success) {
      const message =
        'error' in result && typeof result.error === 'object' && result.error
          ? ((result.error as { message?: string }).message ?? 'unknown error')
          : 'unknown error';
      logger.error({
        operation: 'network-config.load',
        status: 'failure',
        config_path: configPath,
        error: message,
      });
      throw new Error(`network-config load failed: ${message}`);
    }
    cached = result.value;
    // First and only point in the process where both halves are known: the
    // `SIGNALS_UI_URLS` keys (parsed at module load, before any config exists)
    // and the network's declared domains. A key that matches no domain —
    // `seekr=…` for `seeker` — is well-formed, so the parser passes it, and
    // then the hand-off for the real domain never appears with nothing said.
    // Warn only: see `unknownSignalsUiUrlDomains` for why this must not filter.
    for (const domain of unknownSignalsUiUrlDomains(signalsUiUrls, cached.domainIds)) {
      logger.warn(
        {
          operation: 'config.signalsUiUrls.domainCheck',
          status: 'unknown_domain',
          domain,
          known_domains: cached.domainIds,
        },
        `SIGNALS_UI_URLS: domain "${domain}" is not declared by this network — its Signals hand-off will never appear`,
      );
    }
    warnOnOnboardingAllowList(cached);
    logger.info(
      {
        operation: 'network-config.load',
        status: 'success',
        network_id: cached.network.id,
        domain_ids: cached.domainIds,
        brand: cached.aggregator.brand.short_name,
      },
      'aggregator network config resolved',
    );
    return cached;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Cross-checks the `AGGREGATOR_ONBOARDING_ENABLED` allow-list (#637) against
 * the registration modes this network actually declares, and emits the
 * diagnostics that env var otherwise has no way of producing.
 *
 * Two distinct failures, both invisible without this:
 *
 * 1. A value naming no declared mode (`frm` for `form`, or `bulk` while bulk
 *    gating is unimplemented) parses perfectly clean at module load, then
 *    withholds a mode nobody asked to withhold. Warn — never filter, and never
 *    fail the load: this is an optional narrowing knob, and a mode added to the
 *    YAML ahead of the ConfigMap rollout must not break boot.
 * 2. An allow-list that survives the intersection with the declared modes
 *    *empty* leaves the operator with an empty mode dropdown and no way to
 *    create any link at all. Logged at **error**, because it is a
 *    deployment-breaking typo. Note what is deliberately NOT done: falling back
 *    to "all enabled". That would mask the typo and re-enable the very modes
 *    the operator set out to withhold — explicit config wins, it just has to be
 *    loud.
 *
 * @param cfg - The freshly resolved network config.
 */
function warnOnOnboardingAllowList(cfg: ResolvedNetworkConfig): void {
  const capabilities = onboardingEnabledCapabilities();
  if (capabilities === null) return;
  const declaredModes = Object.keys(cfg.aggregator.registration_modes ?? {});
  for (const capability of unknownOnboardingCapabilities(capabilities, declaredModes)) {
    logger.warn(
      {
        operation: 'config.onboardingEnabled.modeCheck',
        status: 'unknown_capability',
        capability,
        declared_modes: declaredModes,
      },
      `AGGREGATOR_ONBOARDING_ENABLED: "${capability}" matches no registration mode declared by this network — it enables nothing`,
    );
  }
  const enabledModes = declaredModes.filter((mode) => capabilities.includes(mode));
  if (enabledModes.length === 0) {
    logger.error(
      {
        operation: 'config.onboardingEnabled.modeCheck',
        status: 'failure',
        enabled: capabilities,
        declared_modes: declaredModes,
      },
      `AGGREGATOR_ONBOARDING_ENABLED="${capabilities.join(',')}" enables none of this network's registration modes (${declaredModes.join(', ') || 'none declared'}) — no registration link can be created. Fix the value, or unset it to enable all modes.`,
    );
  }
}

/** Test helper — inject a fake config; pass null to force re-load. */
export function _setNetworkConfig(cfg: ResolvedNetworkConfig | null): void {
  cached = cfg;
}
