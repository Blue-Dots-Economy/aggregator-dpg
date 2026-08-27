/**
 * Lazy voice-provider factory for the worker process (aggregator-dpg#577).
 *
 * Returns a singleton {@link VoiceProviderBase} built from `config.RAYA_*`,
 * wired with the fail-closed Raya egress gate (`acquireRayaSlot`) over this
 * process's shared Redis connection. Mirrors `signalstack.ts`'s lazy-init
 * shape, but voice has no "push disabled" opt-out — `CAMPAIGN_VOICE_PROVIDER`
 * always names a provider, so a missing `RAYA_API_KEY` is a hard
 * misconfiguration, not a silent skip: it throws `ConfigError` the first time
 * a voice job actually needs the provider, rather than at process boot (a
 * deployment that never runs a voice campaign shouldn't fail to start over an
 * unset Raya key).
 *
 * @module @aggregator-dpg/worker
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';
import {
  acquireRayaSlot,
  getVoiceProvider as buildVoiceProvider,
} from '@aggregator-dpg/voice-provider';
import type { VoiceProviderBase } from '@aggregator-dpg/voice-provider/interface';
import { config } from '../config.js';
import { getRedis } from './redis.js';

let provider: VoiceProviderBase | undefined;

/**
 * Returns the singleton voice provider, constructing it on first use.
 *
 * @returns The configured {@link VoiceProviderBase} instance.
 * @throws {ConfigError} If `RAYA_API_KEY` is unset — required to actually
 *   call the provider, even though it's optional at process boot.
 */
export function getVoiceProvider(): VoiceProviderBase {
  if (provider) return provider;
  const apiKey = config.RAYA_API_KEY;
  if (!apiKey) {
    throw new ConfigError('RAYA_API_KEY must be set to run a voice campaign job', {
      code: 'RAYA_API_KEY_MISSING',
    });
  }
  provider = buildVoiceProvider({
    provider: config.CAMPAIGN_VOICE_PROVIDER,
    baseUrl: config.RAYA_BASE_URL,
    apiKey,
    timeoutMs: config.RAYA_TIMEOUT_MS,
    acquireSlot: () =>
      acquireRayaSlot({
        redis: getRedis(),
        windowSeconds: config.RAYA_EGRESS_WINDOW_SECONDS,
        max: config.RAYA_EGRESS_MAX,
      }),
  });
  return provider;
}

/** Test helper — inject a fake or reset to force reconstruction. */
export function _setVoiceProvider(p: VoiceProviderBase | undefined): void {
  provider = p;
}
