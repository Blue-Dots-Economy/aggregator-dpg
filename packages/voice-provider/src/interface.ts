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
  /**
   * Set by the caller when this `dispatch()` is a BullMQ retry (`attempt >
   * 1`), never on a first attempt. A concrete provider MAY use this as a
   * hint to look up and reuse an already-created batch under `batchName`
   * before creating a new one (see `raya.ts`'s I4 batch-reuse note) —
   * guarding against a transient-start-failure retry minting a duplicate
   * batch, without paying that lookup's latency/egress cost on the
   * overwhelming-majority first-attempt path, where no such batch can
   * exist yet. Omitted/`false` = do not attempt reuse.
   */
  reuseExisting?: boolean;
}

/**
 * Compile-time-only brand marking a provider response payload as already
 * curated down to a PII-excluded persistence whitelist (see `raya.ts`'s
 * `curateCreateResponse`/`curateStartResponse` and `testing.ts`'s twin
 * `pickWhitelisted`). The brand carries no runtime value — it exists purely
 * so `VoiceDispatchResult.providerResponse` can only ever hold data that
 * passed through a provider's own curation step: a raw upstream payload
 * (which may carry `errors[].value`/`data[]` PII, per the module note in
 * `raya.ts`) doesn't type-check as this type, so it can't reach the
 * worker's `setProviderResponse` call by accident. PII-exclusion becomes a
 * compile-time guarantee at the provider boundary, not just a convention.
 */
declare const CURATED_PROVIDER_RESPONSE: unique symbol;
export type CuratedProviderResponse<T = Record<string, unknown>> = T & {
  readonly [CURATED_PROVIDER_RESPONSE]: true;
};

/**
 * Brands an already-curated (whitelist-only) payload as safe to persist.
 * The only sanctioned way to produce a {@link CuratedProviderResponse} —
 * call this at the end of a provider's own curation helper (after every
 * PII-bearing field has been stripped), never directly on a raw upstream
 * payload.
 *
 * @param value - Already-curated (whitelist-only) data.
 * @returns The same value, tagged at the type level as curated.
 */
export function brandCuratedProviderResponse<T extends Record<string, unknown>>(
  value: T,
): CuratedProviderResponse<T> {
  return value as CuratedProviderResponse<T>;
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
  /**
   * Curated provider responses for the create and start calls, captured for
   * audit/debugging. Typed as {@link CuratedProviderResponse} — a provider
   * adapter cannot assign a raw upstream payload here without an explicit
   * (and clearly wrong) cast, so PII-exclusion at this boundary is enforced
   * by the compiler, not just by convention.
   */
  providerResponse: {
    create: CuratedProviderResponse;
    start: CuratedProviderResponse | null;
  };
}

/**
 * Abstract base class for a voice-calling provider.
 *
 * Concrete implementations (in-memory fake, real HTTP adapter) must extend
 * this class and implement every method with the exact same signature. The
 * `action` axis today only covers `dispatch` (create + start) — nothing in
 * this repo calls a stop/update action yet, so those aren't declared here;
 * add them (with a real implementation, not a not-implemented stub) when a
 * campaign-control action actually needs one.
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
}
