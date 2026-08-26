/**
 * Public barrel + provider factory for the campaign voice channel
 * (aggregator-dpg#577). Re-exports the `./interface` contract, the
 * `./egress` rate-limit gate, and `getVoiceProvider` — the only supported
 * way to obtain a concrete {@link VoiceProviderBase} instance. Concrete
 * provider modules (e.g. `./raya.js`) are never imported directly by other
 * packages, per the base-class-pattern rule.
 *
 * @module @aggregator-dpg/voice-provider
 */

import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

import { RayaVoiceProvider } from './raya.js';
import type { VoiceProviderBase } from './interface.js';

/** Configuration accepted by {@link getVoiceProvider}. */
export interface VoiceProviderConfig {
  /** Which concrete provider to construct. Only `'raya'` is supported today. */
  provider: 'raya';
  /** Provider API base URL. */
  baseUrl: string;
  /** Provider API key. */
  apiKey: string;
  /**
   * Per-attempt request timeout in ms. Required — every external call must
   * carry an explicit timeout (repo `error-handling.md`); there is no
   * built-in default at this layer.
   */
  timeoutMs: number;
  /** Rate-limit gate awaited before every provider HTTP call (see `./egress.js`). */
  acquireSlot: () => Promise<void>;
  /** Optional max total attempts per HTTP call before giving up. Provider-defined default when omitted. */
  maxAttempts?: number;
  /** Optional `fetch` override; lets callers (tests) inject a stub. */
  fetchImpl?: typeof fetch;
}

/**
 * Constructs the configured voice provider.
 *
 * @param cfg - Provider selector plus connection/rate-limit config.
 * @returns A {@link VoiceProviderBase} instance for `cfg.provider`.
 * @throws {ConfigError} If `cfg.provider` names an unsupported provider.
 */
export function getVoiceProvider(cfg: VoiceProviderConfig): VoiceProviderBase {
  switch (cfg.provider) {
    case 'raya':
      return new RayaVoiceProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
        acquireSlot: cfg.acquireSlot,
        ...(cfg.maxAttempts !== undefined ? { maxAttempts: cfg.maxAttempts } : {}),
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
      });
    default: {
      const exhaustive: never = cfg.provider;
      throw new ConfigError(`unknown voice provider: ${String(exhaustive)}`);
    }
  }
}

export { VoiceProviderBase } from './interface.js';
export type { VoiceContact, VoiceDispatchInput, VoiceDispatchResult } from './interface.js';
export { acquireRayaSlot } from './egress.js';
export type { AcquireRayaSlotDeps } from './egress.js';
