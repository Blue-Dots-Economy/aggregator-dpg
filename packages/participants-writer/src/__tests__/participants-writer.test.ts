/**
 * Unit tests for InMemoryParticipantsWriter, ParticipantsWriterFake, and
 * PostgresParticipantsWriter.
 *
 * The Postgres impl is exercised against a minimal stub that mimics the
 * Drizzle insert/select chain (per testing.md §1 — third-party adapters may
 * be stubbed rather than faked) so the UPSERT / conflict-lookup / error
 * branches run without a real database.
 *
 * @module @aggregator-dpg/participants-writer
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryParticipantsWriter } from '../memory.js';
import { ParticipantsWriterFake } from '../testing.js';
import { PostgresParticipantsWriter } from '../postgres.js';
import type { BulkRowInput, LinkSubmissionInput, SignalStackInput } from '../interface.js';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';

const AGG_ID = '11111111-1111-1111-1111-111111111111';

function makeBulkRowInput(overrides: Partial<BulkRowInput> = {}): BulkRowInput {
  return {
    aggregatorId: AGG_ID,
    type: 'seeker',
    participantId: 'p-1',
    data: { name: 'Alpha' },
    phone: '9999999999',
    email: null,
    sourceBulkUploadId: 'bulk-1',
    sourceRowIndex: 0,
    ...overrides,
  };
}

function makeLinkInput(overrides: Partial<LinkSubmissionInput> = {}): LinkSubmissionInput {
  return {
    aggregatorId: AGG_ID,
    type: 'seeker',
    participantId: 'p-2',
    data: { name: 'Beta' },
    phone: null,
    email: 'beta@example.com',
    sourceLinkId: 'link-1',
    ...overrides,
  };
}

function makeSignalStackInput(overrides: Partial<SignalStackInput> = {}): SignalStackInput {
  return {
    aggregatorId: AGG_ID,
    type: 'seeker',
    participantId: 'p-3',
    data: {},
    phone: null,
    email: null,
    sourceSignalStackEventId: 'evt-1',
    ...overrides,
  };
}

// ─── Fake Drizzle db stub for PostgresParticipantsWriter ───────────────────

interface FakeDbOptions {
  insertRows?: Array<{ id: string }>;
  selectRows?: Array<{ id: string }>;
  insertThrows?: Error;
}

function makeFakeDb(options: FakeDbOptions = {}) {
  const { insertRows = [{ id: 'pg-1' }], selectRows = [], insertThrows } = options;
  const calls: { insertValues?: unknown; onConflictOpts?: unknown; selectCalled?: boolean } = {};

  const db = {
    insert() {
      return {
        values(vals: unknown) {
          calls.insertValues = vals;
          return {
            onConflictDoNothing(opts: unknown) {
              calls.onConflictOpts = opts;
              return {
                async returning() {
                  if (insertThrows) throw insertThrows;
                  return insertRows;
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              calls.selectCalled = true;
              return {
                limit: async () => selectRows,
              };
            },
          };
        },
      };
    },
  };

  return { db, calls };
}

// ─── InMemoryParticipantsWriter ─────────────────────────────────────────────

describe('InMemoryParticipantsWriter', () => {
  let writer: InMemoryParticipantsWriter;

  beforeEach(() => {
    writer = new InMemoryParticipantsWriter();
  });

  it('inserts a new participant on writeBulkRow and returns outcome "passed"', async () => {
    const result = await writer.writeBulkRow(makeBulkRowInput());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('passed');
    expect(result.value.participant).toMatchObject({
      aggregatorId: AGG_ID,
      type: 'seeker',
      participantId: 'p-1',
    });
    expect(writer.list()).toHaveLength(1);
  });

  it('dedups a repeated (aggregatorId, type, participantId) on writeBulkRow as "skipped"', async () => {
    const first = await writer.writeBulkRow(makeBulkRowInput());
    const second = await writer.writeBulkRow(makeBulkRowInput({ data: { name: 'Alpha v2' } }));

    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.value.outcome).toBe('passed');
    expect(second.value.outcome).toBe('skipped');
    expect(second.value.participant.id).toBe(first.value.participant.id);
    expect(writer.list()).toHaveLength(1);
  });

  it('inserts a new participant on writeLinkSubmission and returns outcome "passed"', async () => {
    const result = await writer.writeLinkSubmission(makeLinkInput());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('passed');
    expect(result.value.participant.participantId).toBe('p-2');
  });

  it('dedups writeLinkSubmission against an existing writeBulkRow row for the same key', async () => {
    await writer.writeBulkRow(makeBulkRowInput({ participantId: 'shared-1' }));
    const result = await writer.writeLinkSubmission(makeLinkInput({ participantId: 'shared-1' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('skipped');
  });

  it('inserts a new participant on writeSignalStackEvent and returns outcome "passed"', async () => {
    const result = await writer.writeSignalStackEvent(makeSignalStackInput());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('passed');
    expect(result.value.participant.participantId).toBe('p-3');
  });

  it('assigns sequential generated ids to distinct participants', async () => {
    const r1 = await writer.writeBulkRow(makeBulkRowInput({ participantId: 'a' }));
    const r2 = await writer.writeBulkRow(makeBulkRowInput({ participantId: 'b' }));
    expect(r1.success && r2.success).toBe(true);
    if (!r1.success || !r2.success) return;
    expect(r1.value.participant.id).not.toBe(r2.value.participant.id);
  });

  it('list() returns an empty array when nothing has been written', () => {
    expect(writer.list()).toEqual([]);
  });
});

// ─── ParticipantsWriterFake ─────────────────────────────────────────────────

describe('ParticipantsWriterFake', () => {
  let fake: ParticipantsWriterFake;

  beforeEach(() => {
    fake = new ParticipantsWriterFake();
  });

  it('seed() makes rows retrievable via list()', () => {
    fake.seed([{ aggregatorId: AGG_ID, type: 'seeker', participantId: 'seed-1' }]);
    expect(fake.list()).toHaveLength(1);
    expect(fake.list()[0]).toMatchObject({ participantId: 'seed-1', data: {}, phone: null });
  });

  it('seed() overwrites a row sharing the same dedup key', () => {
    fake.seed([{ aggregatorId: AGG_ID, type: 'seeker', participantId: 'dup', data: { v: 1 } }]);
    fake.seed([{ aggregatorId: AGG_ID, type: 'seeker', participantId: 'dup', data: { v: 2 } }]);
    expect(fake.list()).toHaveLength(1);
    expect(fake.list()[0]?.data).toEqual({ v: 2 });
  });

  it('seeded rows are hit as dedup skips by subsequent writer calls', async () => {
    fake.seed([{ aggregatorId: AGG_ID, type: 'seeker', participantId: 'exists' }]);
    const result = await fake.writeBulkRow(makeBulkRowInput({ participantId: 'exists' }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('skipped');
  });

  it('assigns default seed ids when none is provided, and honours an explicit id', () => {
    fake.seed([
      { aggregatorId: AGG_ID, type: 'seeker', participantId: 'no-id' },
      { aggregatorId: AGG_ID, type: 'seeker', participantId: 'with-id', id: 'explicit-id' },
    ]);
    const rows = fake.list();
    expect(rows.find((r) => r.participantId === 'with-id')?.id).toBe('explicit-id');
    expect(rows.find((r) => r.participantId === 'no-id')?.id).toMatch(/^seed-participant-/);
  });
});

// ─── PostgresParticipantsWriter ─────────────────────────────────────────────

describe('PostgresParticipantsWriter', () => {
  it('writeBulkRow returns "passed" with the inserted id when the UPSERT inserts a fresh row', async () => {
    const { db, calls } = makeFakeDb({ insertRows: [{ id: 'pg-bulk-1' }] });
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeBulkRow(makeBulkRowInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('passed');
    expect(result.value.participant.id).toBe('pg-bulk-1');
    expect(calls.insertValues).toMatchObject({
      aggregatorId: AGG_ID,
      sourceBulkUploadId: 'bulk-1',
      sourceRowIndex: 0,
    });
    expect(calls.insertValues).not.toHaveProperty('sourceLinkId');
  });

  it('writeLinkSubmission sets sourceLinkId and omits bulk provenance fields', async () => {
    const { db, calls } = makeFakeDb({ insertRows: [{ id: 'pg-link-1' }] });
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeLinkSubmission(makeLinkInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('passed');
    expect(calls.insertValues).toMatchObject({ sourceLinkId: 'link-1' });
    expect(calls.insertValues).not.toHaveProperty('sourceBulkUploadId');
    expect(calls.insertValues).not.toHaveProperty('sourceRowIndex');
  });

  it('falls back to a lookup and returns "skipped" when the UPSERT hits a dedup conflict', async () => {
    const { db } = makeFakeDb({ insertRows: [], selectRows: [{ id: 'existing-1' }] });
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeBulkRow(makeBulkRowInput());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.outcome).toBe('skipped');
    expect(result.value.participant.id).toBe('existing-1');
  });

  it('returns err(DomainError) when a conflict is hit but the existing row cannot be found', async () => {
    const { db } = makeFakeDb({ insertRows: [], selectRows: [] });
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeBulkRow(makeBulkRowInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('PARTICIPANT_LOOKUP_FAILED');
  });

  it('returns err(UpstreamError) when the DB throws, wrapping the cause', async () => {
    const dbError = new Error('connection reset');
    const { db } = makeFakeDb({ insertThrows: dbError });
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeBulkRow(makeBulkRowInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(UpstreamError);
    expect(result.error.code).toBe('PARTICIPANTS_WRITE_FAILED');
    expect(result.error.message).toContain('connection reset');
  });

  it('writeSignalStackEvent always returns err(NOT_IMPLEMENTED) without touching the DB', async () => {
    const { db, calls } = makeFakeDb();
    const writer = new PostgresParticipantsWriter(db as never);

    const result = await writer.writeSignalStackEvent(makeSignalStackInput());

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(UpstreamError);
    expect(result.error.code).toBe('NOT_IMPLEMENTED');
    expect(calls.insertValues).toBeUndefined();
  });
});
