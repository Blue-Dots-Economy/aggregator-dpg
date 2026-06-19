/**
 * Testing fake for ParticipantsWriterBase.
 *
 * Consumers in other packages (apps/api, apps/worker) import this fake from
 * `@aggregator-dpg/participants-writer/testing` rather than reaching into
 * `./memory`. Adds a `seed()` helper for arrange-act-assert tests.
 */

import { InMemoryParticipantsWriter } from './memory.js';
import type { ParticipantType } from './interface.js';

export { InMemoryParticipantsWriter };

/**
 * Seed payload for `ParticipantsWriterFake.seed()`. Mirrors the shape an
 * arrange step needs without coupling to the internal `StoredParticipant`
 * row format.
 */
export interface ParticipantSeed {
  id?: string;
  aggregatorId: string;
  type: ParticipantType;
  participantId: string;
  data?: Record<string, unknown>;
  phone?: string | null;
  email?: string | null;
}

export class ParticipantsWriterFake extends InMemoryParticipantsWriter {
  /**
   * Inserts the given participants directly into the underlying store, bypassing
   * the writer methods. Useful when a test needs an existing participant to
   * exercise the dedup path.
   *
   * Re-seeding the same dedup key overwrites the previous row.
   */
  seed(seeds: ParticipantSeed[]): void {
    let counter = 1;
    for (const s of seeds) {
      const id = s.id ?? `seed-participant-${counter++}`;
      const key = `${s.aggregatorId}|${s.type}|${s.participantId}`;
      // Reach into the protected Map<string, StoredParticipant> on the
      // in-memory writer. Tests own this surface.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).rows.set(key, {
        id,
        aggregatorId: s.aggregatorId,
        type: s.type,
        participantId: s.participantId,
        data: s.data ?? {},
        phone: s.phone ?? null,
        email: s.email ?? null,
        sourceBulkUploadId: null,
        sourceLinkId: null,
        sourceRowIndex: null,
      });
    }
  }
}
