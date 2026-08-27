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
 * `dispatch()` models Raya's REAL raw response shape internally — including
 * `errors[].value` (the raw rejected phone) and `data[]` (a full echo of the
 * submitted contact rows) — then curates it down to the same persistence
 * whitelist `raya.ts`'s `RayaVoiceProvider` applies before it ever reaches
 * `providerResponse`. The whitelist is duplicated rather than imported: the
 * base-class-pattern forbids importing the concrete Raya adapter by module
 * path even from within this package (`getVoiceProvider` in `./index.js` is
 * the only sanctioned way to obtain a concrete provider). Keep the two lists
 * in step by hand if `raya.ts`'s whitelist ever changes.
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

/** Twin of `raya.ts`'s `CREATE_RESPONSE_PERSIST_KEYS` — see the module note. */
const CREATE_RESPONSE_PERSIST_KEYS = [
  'status',
  'message',
  'totalRows',
  'validRows',
  'invalidRows',
  'batchId',
  'contactsInserted',
] as const;

/** Twin of `raya.ts`'s `START_RESPONSE_PERSIST_KEYS` — see the module note. */
const START_RESPONSE_PERSIST_KEYS = [
  'id',
  'status',
  'total_contacts',
  'completed_contacts',
  'unanswered_contacts',
  'schedule',
  'max_retries',
  'concurrency',
  'retry_after_hrs',
] as const;

/** Picks only the whitelisted keys present on `payload` — twin of `raya.ts`'s curate helpers. */
function pickWhitelisted(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

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
    // Modelled on Raya's real `errors[]` shape: `value` echoes the raw
    // rejected phone number back (PII) — curated out below, same as `raya.ts`.
    const rawErrors: Array<{ row: number; field: string; value: string; message: string }> = [];
    input.contacts.forEach((contact, index) => {
      const rejection = this.pendingRejections.get(contact.ref);
      if (rejection !== undefined) {
        this.pendingRejections.delete(contact.ref);
        rejected.push({ ref: contact.ref, error: rejection });
        rawErrors.push({
          row: index + 1,
          field: 'contact_phone',
          value: contact.phone,
          message: rejection,
        });
      } else {
        accepted.push(contact.ref);
      }
    });

    const providerBatchRef = `mem-batch-${this.nextBatchSeq++}`;

    // Modelled on Raya's real raw payloads: `data[]` echoes the full
    // submitted contact rows (name/phone, PII) the way Raya's actual
    // `POST /batch` response does — see the module note. Never returned
    // as-is; always passed through `pickWhitelisted` first.
    const rawCreate: Record<string, unknown> = {
      status: accepted.length > 0 ? 'success' : 'failed',
      message: 'batch created',
      batchId: providerBatchRef,
      totalRows: input.contacts.length,
      validRows: accepted.length,
      invalidRows: rejected.length,
      contactsInserted: accepted.length,
      errors: rawErrors,
      data: input.contacts.map((c) => ({
        ref: c.ref,
        contact_name: c.name,
        contact_phone: c.phone,
      })),
    };
    // Also models an unlisted field (`webhook_url`) to prove curation drops
    // anything outside the whitelist, not just the two known-PII fields.
    const rawStart: Record<string, unknown> = {
      id: providerBatchRef,
      status: 'Active',
      total_contacts: accepted.length,
      completed_contacts: 0,
      unanswered_contacts: accepted.length,
      schedule: input.startOptions['schedule'] ?? null,
      max_retries: input.startOptions['max_retries'] ?? null,
      concurrency: input.startOptions['max_concurrent_calls'] ?? null,
      retry_after_hrs: input.startOptions['retry_after_hrs'] ?? null,
      webhook_url: 'https://internal.example.com/hooks/mem',
    };

    return ok({
      providerBatchRef,
      accepted,
      rejected,
      providerResponse: {
        create: pickWhitelisted(rawCreate, CREATE_RESPONSE_PERSIST_KEYS),
        start: pickWhitelisted(rawStart, START_RESPONSE_PERSIST_KEYS),
      },
    });
  }
}
