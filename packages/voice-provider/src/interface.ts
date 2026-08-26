/**
 * Public interface contract for the campaign voice channel (aggregator-dpg#577).
 *
 * `VoiceProviderBase` is the provider-agnostic port the campaign worker's
 * voice handler dispatches through — concrete providers (e.g. Raya) live in
 * their own module and extend this class. External packages import
 * exclusively from this subpath, never from a concrete provider module
 * directly.
 *
 * @module @aggregator-dpg/voice-provider/interface
 */

import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err } from '@aggregator-dpg/shared-primitives/result';
import { DomainError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * A single call-recipient row within a voice dispatch batch.
 */
export interface VoiceContact {
  /** Caller-assigned identifier correlating this contact back to a `campaign_job_item`. */
  ref: string;
  /** Recipient display name, passed through to the provider as a call variable. */
  name: string;
  /** Recipient phone number in the format the provider expects. */
  phone: string;
  /** Optional country calling code (e.g. `+91`), when the provider requires it separately from `phone`. */
  countryCode?: string;
  /** Template variables interpolated into the voice script (e.g. role, employer). */
  variables: Record<string, string>;
}

/**
 * Input to {@link VoiceProviderBase.dispatch} — one outbound-call batch.
 */
export interface VoiceDispatchInput {
  /** Provider-side agent/flow identifier to run the batch against. */
  agentRef: string;
  /** Human-readable batch name surfaced in the provider's own dashboard. */
  batchName: string;
  /** Recipients to include in the batch. */
  contacts: VoiceContact[];
  /** Provider-specific start options (e.g. `max_concurrent_calls`, `selected_statuses`). */
  startOptions: Record<string, unknown>;
}

/**
 * Result of a successful (or partially successful) {@link VoiceProviderBase.dispatch} call.
 */
export interface VoiceDispatchResult {
  /** Provider-assigned identifier for the created batch. */
  providerBatchRef: string;
  /** `ref`s of contacts the provider accepted into the batch. */
  accepted: string[];
  /** `ref` + reason for contacts the provider rejected at create time. */
  rejected: { ref: string; error: string }[];
  /** Raw provider responses for the create and start calls, captured for audit/debugging. */
  providerResponse: { create: unknown; start: unknown };
}

/**
 * Abstract base class for a voice-calling provider.
 *
 * Concrete implementations (in-memory fake, real HTTP adapter) must extend
 * this class and implement every method with the exact same signature. The
 * `action` axis today only covers `dispatch` (create + start); `stop` and
 * `update` are declared for a future extension and currently return a
 * not-implemented error rather than being omitted, so callers can already
 * code against the full future surface.
 */
export abstract class VoiceProviderBase {
  /**
   * Creates and starts an outbound-call batch with the given contacts.
   *
   * @param input - The batch definition (agent, name, contacts, start options).
   * @returns Ok with the provider batch reference and per-contact accept/reject
   *   outcome, or Err if the batch could not be created at all.
   */
  abstract dispatch(input: VoiceDispatchInput): Promise<Result<VoiceDispatchResult, BaseError>>;

  /**
   * Stops an in-flight voice batch. Reserved for a future campaign-control
   * action (the `action` axis today only covers `dispatch`) — the base
   * implementation returns a not-implemented error so every current and
   * future provider gets consistent behaviour without duplicating this
   * stub. Override once the provider surface adds a stop endpoint.
   *
   * @param _providerBatchRef - The provider batch reference to stop.
   * @returns Err(DomainError) with code `NOT_IMPLEMENTED`.
   */
  stop(_providerBatchRef: string): Promise<Result<void, BaseError>> {
    return Promise.resolve(
      err(new DomainError('stop is not implemented', { code: 'NOT_IMPLEMENTED' })),
    );
  }

  /**
   * Updates an in-flight voice batch's contacts or options. Reserved for a
   * future campaign-control action — see {@link stop} for why the base
   * class provides a default rather than each provider re-declaring it.
   *
   * @param _providerBatchRef - The provider batch reference to update.
   * @param _input - The updated batch definition.
   * @returns Err(DomainError) with code `NOT_IMPLEMENTED`.
   */
  update(_providerBatchRef: string, _input: VoiceDispatchInput): Promise<Result<void, BaseError>> {
    return Promise.resolve(
      err(new DomainError('update is not implemented', { code: 'NOT_IMPLEMENTED' })),
    );
  }
}
