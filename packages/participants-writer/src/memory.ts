/**
 * In-memory ParticipantsWriter — Map-backed, used by unit tests in this
 * package. Cross-package consumers should import the testing fake from
 * `./testing` instead (which extends this with a `seed()` helper).
 *
 * Dedup is enforced on the same key as production: composite
 * `(aggregator_id, type, participant_id)`. Insertion order is the
 * deterministic id assigned to new rows.
 */

import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

import {
  ParticipantsWriterBase,
  type BulkRowInput,
  type LinkSubmissionInput,
  type ParticipantType,
  type SignalStackInput,
  type WriteResult,
  type WrittenParticipant,
} from './interface.js';

interface StoredParticipant {
  id: string;
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
  data: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  sourceBulkUploadId: string | null;
  sourceLinkId: string | null;
  sourceRowIndex: number | null;
}

function dedupKey(aggregatorId: string, type: ParticipantType, participantId: string): string {
  return `${aggregatorId}|${type}|${participantId}`;
}

export class InMemoryParticipantsWriter extends ParticipantsWriterBase {
  protected readonly rows: Map<string, StoredParticipant> = new Map();
  private nextId = 1;

  override writeBulkRow(input: BulkRowInput): Promise<Result<WriteResult, BaseError>> {
    return Promise.resolve(
      this.upsert({
        aggregatorId: input.aggregatorId,
        type: input.type,
        participantId: input.participantId,
        data: input.data,
        phone: input.phone,
        email: input.email,
        sourceBulkUploadId: input.sourceBulkUploadId,
        sourceLinkId: null,
        sourceRowIndex: input.sourceRowIndex,
      }),
    );
  }

  override writeLinkSubmission(
    input: LinkSubmissionInput,
  ): Promise<Result<WriteResult, BaseError>> {
    return Promise.resolve(
      this.upsert({
        aggregatorId: input.aggregatorId,
        type: input.type,
        participantId: input.participantId,
        data: input.data,
        phone: input.phone,
        email: input.email,
        sourceBulkUploadId: null,
        sourceLinkId: input.sourceLinkId,
        sourceRowIndex: null,
      }),
    );
  }

  override writeSignalStackEvent(input: SignalStackInput): Promise<Result<WriteResult, BaseError>> {
    return Promise.resolve(
      this.upsert({
        aggregatorId: input.aggregatorId,
        type: input.type,
        participantId: input.participantId,
        data: input.data,
        phone: input.phone,
        email: input.email,
        sourceBulkUploadId: null,
        sourceLinkId: null,
        sourceRowIndex: null,
      }),
    );
  }

  /**
   * Returns the list of currently-stored participants. Test helper for
   * package-internal unit tests; external consumers should not depend on it.
   */
  list(): StoredParticipant[] {
    return Array.from(this.rows.values());
  }

  protected upsert(row: Omit<StoredParticipant, 'id'>): Result<WriteResult, BaseError> {
    const key = dedupKey(row.aggregatorId, row.type, row.participantId);
    const existing = this.rows.get(key);
    if (existing) {
      const participant: WrittenParticipant = {
        id: existing.id,
        aggregatorId: existing.aggregatorId,
        type: existing.type,
        participantId: existing.participantId,
      };
      return ok({ outcome: 'skipped', participant });
    }
    const id = `mem-participant-${this.nextId++}`;
    const stored: StoredParticipant = { id, ...row };
    this.rows.set(key, stored);
    const participant: WrittenParticipant = {
      id,
      aggregatorId: stored.aggregatorId,
      type: stored.type,
      participantId: stored.participantId,
    };
    return ok({ outcome: 'passed', participant });
  }
}
