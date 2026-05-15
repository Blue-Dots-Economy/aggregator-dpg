/**
 * Participants writer contract — single boundary for every source that
 * registers a participant.
 *
 * Today's sources:
 *   - bulk CSV upload (worker `bulk-row-process`)
 *   - QR / registration link public submit (api public POST handler)
 *
 * Future sources (planned):
 *   - Signal Stack push feed (worker `signal-stack-ingest`)
 *
 * All paths converge on the same `participants` table with the same dedup key
 * `(aggregator_id, type, participant_id)`. The wrapper hides the UPSERT
 * mechanics so callers describe their event semantically; outcome is computed
 * by the writer from the DB result.
 *
 * Every method returns Result<T, BaseError> — never throws.
 */

import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

/** participant_type enum mirror. */
export type ParticipantType = 'seeker' | 'provider';

/**
 * Result classification returned per write attempt. Mirrors the semantics
 * required by both the bulk CSV path (per-row outcome) and the link submission
 * path (synchronous outcome to the public caller).
 */
export type ParticipantWriteOutcome = 'passed' | 'skipped' | 'failed';

/**
 * Common shape for a participant row after write — callers use `id` to FK
 * their per-source rows (`link_submissions.participant_id`, etc.).
 */
export interface WrittenParticipant {
  id: string;
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
}

/**
 * Successful write result. `outcome` distinguishes a freshly-inserted row
 * (`passed`) from a no-op dedup hit (`skipped`). `failed` is returned as the
 * Err branch with a BaseError attached, not in this struct.
 */
export interface WriteResult {
  outcome: Exclude<ParticipantWriteOutcome, 'failed'>;
  participant: WrittenParticipant;
}

/**
 * Input for the bulk CSV path. One call per validated CSV row.
 *
 * `sourceBulkUploadId` + `sourceRowIndex` become provenance on the
 * `participants` row.
 */
export interface BulkRowInput {
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
  data: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  sourceBulkUploadId: string;
  sourceRowIndex: number;
}

/**
 * Input for the QR / registration-link path. One call per validated public
 * form submit. `sourceLinkId` becomes provenance.
 */
export interface LinkSubmissionInput {
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
  data: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  sourceLinkId: string;
}

/**
 * Input for the future Signal Stack push feed. Reserved — not implemented yet
 * by any writer impl. Defined here so the contract is stable from day one.
 */
export interface SignalStackInput {
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
  data: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  sourceSignalStackEventId: string;
}

/**
 * Persistence port for the unified `participants` roster.
 *
 * Implementations:
 *   - Postgres: real Drizzle-backed UPSERT against `participants` table.
 *   - InMemory: Map-backed for unit tests.
 *   - Fake: in-memory + `seed()` helper for cross-package consumer tests.
 */
export abstract class ParticipantsWriterBase {
  /**
   * Write one participant from a bulk CSV row.
   *
   * @param input - Validated, normalised row payload + bulk provenance.
   * @returns ok({ outcome, participant }) on insert (passed) or dedup hit
   *   (skipped); err(BaseError) on DB failure.
   */
  abstract writeBulkRow(input: BulkRowInput): Promise<Result<WriteResult, BaseError>>;

  /**
   * Write one participant from a link form submit.
   *
   * @param input - Validated, normalised form payload + link provenance.
   * @returns ok({ outcome, participant }) on insert (passed) or dedup hit
   *   (skipped); err(BaseError) on DB failure.
   */
  abstract writeLinkSubmission(input: LinkSubmissionInput): Promise<Result<WriteResult, BaseError>>;

  /**
   * Write one participant from a Signal Stack push event (future).
   *
   * @param input - Event payload with signal-stack provenance.
   * @returns Same shape as the other writers.
   */
  abstract writeSignalStackEvent(input: SignalStackInput): Promise<Result<WriteResult, BaseError>>;
}
