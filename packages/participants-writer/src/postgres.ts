/**
 * Drizzle-backed ParticipantsWriter — real production impl.
 *
 * Writes to the `participants` table. Uses ON CONFLICT DO NOTHING on the
 * dedup key (aggregator_id, type, participant_id). On a no-op conflict the
 * existing row is fetched so the caller always receives an FK-usable id.
 *
 * Caller-supplied transaction is optional. The link path passes a tx so the
 * UPSERT and the `link_submissions` INSERT commit atomically; the bulk path
 * uses the implicit pool connection (per-row).
 */

import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { participants } from '@aggregator-dpg/db-schema/schema';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { err, ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';

import {
  ParticipantsWriterBase,
  type BulkRowInput,
  type LinkSubmissionInput,
  type SignalStackInput,
  type WriteResult,
  type WrittenParticipant,
} from './interface.js';

// Drizzle is generic over its schema map; we only need a "queryable" handle.
// Accept the loosest viable type so both `db` and `tx` callers pass through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbHandle = PgDatabase<any, any, any>;

interface WriteCommon {
  aggregatorId: string;
  type: 'seeker' | 'provider';
  participantId: string;
  data: Record<string, unknown>;
  phone: string | null;
  email: string | null;
}

interface SourceFields {
  sourceBulkUploadId?: string;
  sourceLinkId?: string;
  sourceRowIndex?: number;
}

export class PostgresParticipantsWriter extends ParticipantsWriterBase {
  constructor(private readonly db: DbHandle) {
    super();
  }

  override writeBulkRow(input: BulkRowInput): Promise<Result<WriteResult, BaseError>> {
    return this.write(input, {
      sourceBulkUploadId: input.sourceBulkUploadId,
      sourceRowIndex: input.sourceRowIndex,
    });
  }

  override writeLinkSubmission(
    input: LinkSubmissionInput,
  ): Promise<Result<WriteResult, BaseError>> {
    return this.write(input, {
      sourceLinkId: input.sourceLinkId,
    });
  }

  override writeSignalStackEvent(
    _input: SignalStackInput,
  ): Promise<Result<WriteResult, BaseError>> {
    return Promise.resolve(
      err(
        new UpstreamError('signal_stack writer not yet implemented', {
          code: 'NOT_IMPLEMENTED',
        }),
      ),
    );
  }

  private async write(
    common: WriteCommon,
    source: SourceFields,
  ): Promise<Result<WriteResult, BaseError>> {
    try {
      const inserted = await this.db
        .insert(participants)
        .values({
          aggregatorId: common.aggregatorId,
          type: common.type,
          participantId: common.participantId,
          data: common.data,
          phone: common.phone,
          email: common.email,
          ...(source.sourceBulkUploadId !== undefined
            ? { sourceBulkUploadId: source.sourceBulkUploadId }
            : {}),
          ...(source.sourceLinkId !== undefined ? { sourceLinkId: source.sourceLinkId } : {}),
          ...(source.sourceRowIndex !== undefined ? { sourceRowIndex: source.sourceRowIndex } : {}),
        })
        .onConflictDoNothing({
          target: [participants.aggregatorId, participants.type, participants.participantId],
        })
        .returning({ id: participants.id });

      if (inserted.length > 0 && inserted[0]) {
        const participant: WrittenParticipant = {
          id: inserted[0].id,
          aggregatorId: common.aggregatorId,
          type: common.type,
          participantId: common.participantId,
        };
        return ok({ outcome: 'passed', participant });
      }

      // Conflict path — fetch the existing row id so caller can FK to it.
      const existing = await this.db
        .select({ id: participants.id })
        .from(participants)
        .where(
          and(
            eq(participants.aggregatorId, common.aggregatorId),
            eq(participants.type, common.type),
            eq(participants.participantId, common.participantId),
          ),
        )
        .limit(1);

      if (existing.length === 0 || !existing[0]) {
        return err(
          new UpstreamError('participant conflict but existing row not found', {
            code: 'PARTICIPANT_LOOKUP_FAILED',
          }),
        );
      }

      const participant: WrittenParticipant = {
        id: existing[0].id,
        aggregatorId: common.aggregatorId,
        type: common.type,
        participantId: common.participantId,
      };
      return ok({ outcome: 'skipped', participant });
    } catch (e) {
      const cause = e as Error;
      return err(
        new UpstreamError(`participants UPSERT failed: ${cause.message}`, {
          cause,
          code: 'PARTICIPANTS_WRITE_FAILED',
        }),
      );
    }
  }
}
