/**
 * Orchestration tests for `processBulkRow` — the per-row bulk-upload pipeline
 * entry point. The pure helpers (`stripAllEmptyCells`, `blockingValidationReasons`,
 * `pushToSignalStack`) already have dedicated unit tests in
 * `bulk-row-process.test.ts`; this file drives the *whole* function through
 * every branch that file's ~30% baseline coverage missed: participant-type /
 * schema / validation / normalisation / domain failures, the writer +
 * signalstack push interplay (passed / skipped-duplicate / failed, and every
 * way the push itself can fail), the Redis-Lua commit outcome handling
 * (replay, heartbeat flush, Finaliser enqueue), and array-cell preprocessing.
 *
 * DB and Redis are faked (hand-built chainable stubs, matching the pattern
 * already used by the sibling job test files). The participants-writer and
 * signalstack-writer dependencies use the real in-memory `./testing` fakes
 * per testing.md ("fakes over mocks").
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BulkRowProcessJob } from '@aggregator-dpg/queue';
import { err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { DomainError, UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  ParticipantsWriterFake,
  InMemoryParticipantsWriter,
} from '@aggregator-dpg/participants-writer/testing';
import type { BulkRowInput, WriteResult } from '@aggregator-dpg/participants-writer/interface';
import {
  SignalStackWriterFake,
  InMemorySignalStackWriter,
} from '@aggregator-dpg/signalstack-writer/testing';
import type {
  SignalStackOnboardParticipantInput,
  SignalStackOnboardParticipantResult,
} from '@aggregator-dpg/signalstack-writer/interface';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

// ─── DB fake: signalstack-org lookup + heartbeat update ─────────────────────

let orgId: string | null = 'org-signalstack-1';
let heartbeatShouldThrow: Error | null = null;
const heartbeatUpdates: Array<Record<string, unknown>> = [];

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ signalstackOrgId: orgId }],
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        heartbeatUpdates.push(v);
        return {
          where: async () => {
            if (heartbeatShouldThrow) throw heartbeatShouldThrow;
            return undefined;
          },
        };
      },
    }),
  };
}

// ─── Redis fake: `script` (SCRIPT LOAD) + `evalsha` (the Lua row-commit) ────

let evalshaResult: [number, number, number, number] = [1, -1, 0, 1];
const evalshaCalls: unknown[][] = [];

vi.mock('../services/redis.js', () => ({
  getRedis: () => ({
    // The loader asks Redis for the script digest rather than hashing the
    // source itself; any non-empty string is an acceptable stand-in here.
    script: vi.fn(async () => 'f'.repeat(40)),
    evalsha: vi.fn(async (...args: unknown[]) => {
      evalshaCalls.push(args);
      return evalshaResult;
    }),
  }),
}));

// ─── Schema loader fake ──────────────────────────────────────────────────────

interface FakeValidate {
  (data: unknown): boolean;
  errors: Array<{ keyword?: string; instancePath?: string; message?: string }> | null;
}

function makeValidate(
  valid: boolean,
  errors: Array<{ keyword?: string; instancePath?: string; message?: string }> = [],
): FakeValidate {
  const fn = ((_data: unknown) => valid) as FakeValidate;
  fn.errors = errors.length > 0 ? errors : null;
  return fn;
}

type ValidatorResult =
  { success: true; value: FakeValidate } | { success: false; error: { code: string } };
type SchemaResult =
  { success: true; value: Record<string, unknown> } | { success: false; error: { code: string } };

let validatorResult: ValidatorResult = { success: true, value: makeValidate(true) };
let schemaResultVal: SchemaResult = { success: true, value: { required: [], properties: {} } };

vi.mock('../services/schema-loader.js', () => ({
  getSchemaLoader: () => ({
    getValidator: async () => validatorResult,
    getSchema: async () => schemaResultVal,
  }),
}));

// ─── Bulk-queue (Finaliser enqueue) fake ────────────────────────────────────

const enqueueFinalise = vi.fn(async () => undefined);
vi.mock('../services/bulk-queue.js', () => ({ enqueueFinalise }));

vi.mock('../config.js', () => ({
  config: {
    BULK_UPLOAD_REDIS_TTL_SECONDS: 86_400,
    SIGNALSTACK_ITEM_NETWORK: 'blue_dot',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  },
}));

const { processBulkRow, pushToSignalStack, _setParticipantsWriter } =
  await import('./bulk-row-process.js');
const { _setSignalStackWriter } = await import('../services/signalstack.js');
const { _setNetworkConfig } = await import('../services/network-config.js');
const { _setDb } = await import('../db.js');
const { logger } = await import('../logger.js');

// ─── Fakes that fail on demand (extend the real in-memory impls) ───────────

class FailingParticipantsWriter extends InMemoryParticipantsWriter {
  override async writeBulkRow(_input: BulkRowInput): Promise<Result<WriteResult, BaseError>> {
    return err(new DomainError('boom', { code: 'DB_WRITE_FAILED' }));
  }
}

class FailingSignalStackWriter extends InMemorySignalStackWriter {
  constructor(
    private readonly code = 'UPSTREAM_TIMEOUT',
    private readonly message = 'signalstack unreachable',
  ) {
    super();
  }
  override async onboard(
    _input: SignalStackOnboardParticipantInput,
  ): Promise<Result<SignalStackOnboardParticipantResult, BaseError>> {
    return err(new UpstreamError(this.message, { code: this.code }));
  }
}

function makeJob(overrides: Partial<BulkRowProcessJob> = {}): BulkRowProcessJob {
  return {
    uploadId: 'up-1',
    aggregatorId: 'agg-1',
    rowIndex: 0,
    schemaId: 'participant-seeker',
    schemaVersion: 'v1',
    participantType: 'seeker',
    payload: { name: 'Asha', phone: '9876543210', email: 'asha@example.com' },
    ...overrides,
  };
}

/** Extracts {outcome, errorPayload} from the last `evalsha` call args. */
function lastCommit(): { outcome: string; errorPayload: string } {
  const call = evalshaCalls.at(-1)!;
  return { outcome: call[8] as string, errorPayload: call[9] as string };
}

let participantsWriter: ParticipantsWriterFake;
let signalStackWriter: SignalStackWriterFake;

beforeEach(() => {
  vi.clearAllMocks();
  evalshaResult = [1, -1, 0, 1];
  evalshaCalls.length = 0;
  validatorResult = { success: true, value: makeValidate(true) };
  schemaResultVal = { success: true, value: { required: [], properties: {} } };
  orgId = 'org-signalstack-1';
  heartbeatShouldThrow = null;
  heartbeatUpdates.length = 0;
  _setDb(makeDb() as never);
  _setNetworkConfig(buildBlueDotConfig());
  participantsWriter = new ParticipantsWriterFake();
  signalStackWriter = new SignalStackWriterFake();
  _setParticipantsWriter(participantsWriter);
  _setSignalStackWriter(signalStackWriter);
});

afterEach(() => {
  _setDb(null);
  _setNetworkConfig(null);
  _setParticipantsWriter(null);
  _setSignalStackWriter(null);
});

describe('processBulkRow — normal execution', () => {
  it('passes a well-formed row: writes the participant and pushes to signalstack', async () => {
    const result = await processBulkRow(makeJob());
    expect(result).toEqual({ outcome: 'passed', category: null, reasons: [] });
    expect(lastCommit()).toEqual({ outcome: 'passed', errorPayload: '' });
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('treats a missing optional email as null on the writer call', async () => {
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '9876543210' } }),
    );
    expect(result.outcome).toBe('passed');
    const stored = participantsWriter.list()[0]!;
    expect(stored.email).toBeNull();
  });

  it('splits a delimited array-typed cell using the network csv_array_delimiter', async () => {
    schemaResultVal = {
      success: true,
      value: {
        required: [],
        properties: { skills: { type: 'array' }, name: {}, phone: {}, email: {} },
      },
    };
    await processBulkRow(
      makeJob({
        payload: {
          name: 'Asha',
          phone: '9876543210',
          email: 'a@x.com',
          skills: 'welding|carpentry',
        },
      }),
    );
    const stored = participantsWriter.list()[0]!;
    expect(stored.data['skills']).toEqual(['welding', 'carpentry']);
  });
});

describe('processBulkRow — edge cases: rejected before persistence', () => {
  it('fails fast on an unrecognised participant_type', async () => {
    const result = await processBulkRow(makeJob({ participantType: 'ghost' }));
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain('invalid participant_type: ghost');
    expect(lastCommit().outcome).toBe('failed');
    expect(lastCommit().errorPayload).toContain('invalid participant_type');
  });

  it('fails when the schema/validator fails to load', async () => {
    validatorResult = { success: false, error: { code: 'SCHEMA_NOT_FOUND' } };
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain('schema_load_failed: SCHEMA_NOT_FOUND');
  });

  it('fails a row with a blocking (non-required) schema validation error', async () => {
    validatorResult = {
      success: true,
      value: makeValidate(false, [
        { keyword: 'type', instancePath: '/age', message: 'must be number' },
      ]),
    };
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('validation');
    expect(result.reasons[0]).toContain('/age');
  });

  it('passes a row through when the only validation errors are missing-required fields', async () => {
    validatorResult = {
      success: true,
      value: makeValidate(false, [
        { keyword: 'required', message: "must have required property 'x'" },
      ]),
    };
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });

  it('fails with system_error when the participant type has no domain config', async () => {
    _setNetworkConfig(buildBlueDotConfig({ domainIds: ['seeker', 'provider', 'ghost'] }));
    const result = await processBulkRow(makeJob({ participantType: 'ghost' }));
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain("unknown domain 'ghost'");
  });

  it('fails on an unnormalisable phone number', async () => {
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '123', email: 'a@x.com' } }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('normalisation');
    expect(result.reasons[0]).toContain('phone:');
  });
});

describe('processBulkRow — writer + signalstack push interplay', () => {
  it('marks a duplicate participant as skipped when the push still succeeds', async () => {
    participantsWriter.seed([{ aggregatorId: 'agg-1', type: 'seeker', participantId: 'dup-1' }]);
    const result = await processBulkRow(
      makeJob({ payload: { participant_id: 'dup-1', name: 'Asha', phone: '9876543210' } }),
    );
    expect(result).toEqual({
      outcome: 'skipped',
      category: 'duplicate',
      reasons: [`participant_id 'dup-1' already registered for this aggregator`],
    });
  });

  it('flips a duplicate row to failed when the (still-attempted) push fails', async () => {
    participantsWriter.seed([{ aggregatorId: 'agg-1', type: 'seeker', participantId: 'dup-1' }]);
    _setSignalStackWriter(new FailingSignalStackWriter());
    const result = await processBulkRow(
      makeJob({ payload: { participant_id: 'dup-1', name: 'Asha', phone: '9876543210' } }),
    );
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
  });

  it('fails with a db-prefixed reason when the local participant write fails', async () => {
    _setParticipantsWriter(new FailingParticipantsWriter());
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toContain('db: boom');
  });

  it('fails a fresh row with system_error when the signalstack push fails generically', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter('UPSTREAM_TIMEOUT', 'signalstack unreachable'),
    );
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('failed');
    expect(result.category).toBe('system_error');
    expect(result.reasons[0]).toBe('signalstack [UPSTREAM_TIMEOUT]: signalstack unreachable');
  });

  it('categorises a profile-limit push rejection distinctly from a generic system error', async () => {
    _setSignalStackWriter(
      new FailingSignalStackWriter('SIGNALSTACK_PROFILE_LIMIT_REACHED', 'profile cap hit'),
    );
    const result = await processBulkRow(makeJob());
    expect(result.category).toBe('limit_reached');
  });

  it('categorises an owned-elsewhere push rejection distinctly', async () => {
    signalStackWriter.seedForeignUser({ phoneNumber: '+919876543210' });
    const result = await processBulkRow(
      makeJob({ payload: { name: 'Asha', phone: '9876543210' } }),
    );
    expect(result.category).toBe('owned_elsewhere');
  });

  it('treats a disabled signalstack push (opt-out) as success', async () => {
    _setSignalStackWriter(null);
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });
});

describe('pushToSignalStack — direct-call edge cases not reachable through processBulkRow', () => {
  const job = makeJob();

  it('fails with SIGNALSTACK_ORG_NOT_REGISTERED when the aggregator has no signalstack_org_id on file', async () => {
    orgId = null;
    _setDb(makeDb() as never);
    const result = await pushToSignalStack(job, 'pid-1', '+919876543210', null, logger);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('SIGNALSTACK_ORG_NOT_REGISTERED');
  });

  it('fails with UNKNOWN_DOMAIN when the resolved network has no config for the domain', async () => {
    _setNetworkConfig(buildBlueDotConfig({ domainIds: ['seeker', 'provider', 'ghost'] }));
    const result = await pushToSignalStack(
      { ...job, participantType: 'ghost' },
      'pid-2',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('UNKNOWN_DOMAIN');
  });

  it('falls back to the participantId as the pushed name when the identity name field is absent from the payload', async () => {
    const result = await pushToSignalStack(
      { ...job, payload: { phone: '+919876543210' } },
      'pid-fallback-name',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(true);
  });

  it('overrides an empty/missing raw phone cell with the already-normalised pushPhone', async () => {
    // domainCfg.identity.phone === 'phone'; omit it from the payload entirely
    // so buildSignalStackItemState's override branch (rawPhone undefined,
    // pushPhone truthy) is exercised.
    const result = await pushToSignalStack(
      { ...job, payload: { name: 'Asha' } },
      'pid-phone-override',
      '+919876543210',
      null,
      logger,
    );
    expect(result.success).toBe(true);
  });
});

describe('processBulkRow — Redis commit outcome handling', () => {
  it('short-circuits bookkeeping on a replay (wasNew=0): no heartbeat, no Finaliser enqueue', async () => {
    evalshaResult = [5, 10, 0, 0];
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
    expect(heartbeatUpdates).toHaveLength(0);
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('flushes a heartbeat on a PROGRESS_FLUSH_EVERY boundary', async () => {
    evalshaResult = [500, 1000, 0, 1];
    await processBulkRow(makeJob());
    expect(heartbeatUpdates).toHaveLength(1);
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('flushes a heartbeat when processed reaches total even off the 500-boundary', async () => {
    evalshaResult = [7, 7, 0, 1];
    await processBulkRow(makeJob());
    expect(heartbeatUpdates).toHaveLength(1);
  });

  it('enqueues the Finaliser exactly when processed==total and reader_done, with total>0', async () => {
    evalshaResult = [3, 3, 1, 1];
    await processBulkRow(makeJob());
    expect(enqueueFinalise).toHaveBeenCalledTimes(1);
    expect(enqueueFinalise).toHaveBeenCalledWith({ uploadId: 'up-1' });
  });

  it('does not enqueue the Finaliser when total is not yet known (<=0), even if processed==total', async () => {
    evalshaResult = [0, 0, 1, 1];
    await processBulkRow(makeJob());
    expect(enqueueFinalise).not.toHaveBeenCalled();
  });

  it('swallows a heartbeat write failure without failing the row (logged, not thrown)', async () => {
    evalshaResult = [500, 1000, 0, 1];
    heartbeatShouldThrow = new Error('db unavailable');
    const result = await processBulkRow(makeJob());
    expect(result.outcome).toBe('passed');
  });
});
