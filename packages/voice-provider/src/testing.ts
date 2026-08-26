/**
 * In-memory fake for {@link VoiceProviderBase} — the `./testing` subpath
 * consumers (the campaign worker's voice handler, and this package's own
 * unit tests) import instead of a real Raya connection.
 *
 * Records every {@link dispatch} call so tests can assert on what the
 * campaign worker sent, and lets a test pre-arm a per-contact rejection via
 * {@link InMemoryVoiceProvider.setReject} to exercise the partial-batch
 * (`accepted` + `rejected`) path without a real provider error.
 *
 * @module @aggregator-dpg/voice-provider/testing
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import {
  VoiceProviderBase,
  type VoiceDispatchInput,
  type VoiceDispatchResult,
} from './interface.js';

/**
 * In-memory {@link VoiceProviderBase} implementation. Accepts every contact
 * by default; call {@link setReject} before `dispatch()` to simulate a
 * provider-side per-row rejection (e.g. an invalid phone number).
 */
export class InMemoryVoiceProvider extends VoiceProviderBase {
  /** Every `dispatch()` call this instance has received, in call order. */
  readonly dispatches: VoiceDispatchInput[] = [];

  /**
   * Pending rejections keyed by contact `ref`. Consumed (one-shot) the next
   * time a `dispatch()` call includes that `ref`, so a second dispatch for
   * the same ref succeeds unless re-armed.
   */
  private readonly pendingRejections: Map<string, string> = new Map();

  private nextBatchSeq = 1;

  /**
   * Arms a rejection for the next `dispatch()` call containing a contact
   * with this `ref`. The rejection is consumed on use.
   *
   * @param ref - The contact `ref` to reject.
   * @param error - The rejection reason surfaced on `VoiceDispatchResult.rejected`.
   */
  setReject(ref: string, error: string): void {
    this.pendingRejections.set(ref, error);
  }

  override async dispatch(
    input: VoiceDispatchInput,
  ): Promise<Result<VoiceDispatchResult, BaseError>> {
    this.dispatches.push(input);

    const accepted: string[] = [];
    const rejected: { ref: string; error: string }[] = [];
    for (const contact of input.contacts) {
      const rejection = this.pendingRejections.get(contact.ref);
      if (rejection !== undefined) {
        this.pendingRejections.delete(contact.ref);
        rejected.push({ ref: contact.ref, error: rejection });
      } else {
        accepted.push(contact.ref);
      }
    }

    const providerBatchRef = `mem-batch-${this.nextBatchSeq++}`;
    return ok({
      providerBatchRef,
      accepted,
      rejected,
      providerResponse: {
        create: { agentRef: input.agentRef, batchName: input.batchName, accepted, rejected },
        start: { providerBatchRef, startOptions: input.startOptions },
      },
    });
  }
}
