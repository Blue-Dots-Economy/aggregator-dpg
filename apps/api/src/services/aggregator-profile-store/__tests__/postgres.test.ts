/**
 * Unit tests for PostgresAggregatorProfileStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/participants-writer/src/__tests__/participants-writer.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * insert/update/error-mapping logic in `postgres.ts` without a live database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresAggregatorProfileStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import type { AggregatorProfile, CreateAggregatorProfileInput } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeFakeDb(resolve: (chain: ChainCall[]) => unknown): unknown {
  function build(chain: ChainCall[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string | symbol) {
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
              let result: unknown;
              try {
                result = resolve(chain);
              } catch (e) {
                return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e);
              }
              return Promise.resolve(result).then(onFulfilled, onRejected);
            };
          }
          if (prop === 'catch') {
            return (onRejected: (e: unknown) => unknown) =>
              (build(chain) as Promise<unknown>).then(undefined, onRejected);
          }
          return (...args: unknown[]) => build([...chain, { method: String(prop), args }]);
        },
      },
    );
  }
  return build([]);
}

function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

afterEach(() => {
  _setDbClients(null, null);
});

function makeRow(overrides: Partial<AggregatorProfile> = {}): AggregatorProfile {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    aggregatorId: '00000000-0000-0000-0000-000000000001',
    contactName: null,
    personas: [],
    services: [],
    verifiedCertificate: [],
    profileCompletedAt: null,
    createdBy: 'system',
    updatedBy: 'system',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<CreateAggregatorProfileInput> = {},
): CreateAggregatorProfileInput {
  return {
    aggregatorId: '00000000-0000-0000-0000-000000000001',
    createdBy: 'system',
    updatedBy: 'system',
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresAggregatorProfileStore.create', () => {
  it('inserts the mapped row and returns it on success', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ contactName: 'Alice' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.create(makeInput({ contactName: 'Alice' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contactName).toBe('Alice');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      aggregatorId: '00000000-0000-0000-0000-000000000001',
      contactName: 'Alice',
    });
  });

  it('defaults optional fields to null/empty arrays when omitted', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    await store.create(makeInput());

    const values = callArgs(captured, 'values')?.[0] as Record<string, unknown>;
    expect(values.contactName).toBeNull();
    expect(values.personas).toEqual([]);
    expect(values.services).toEqual([]);
    expect(values.verifiedCertificate).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a unique violation to DUPLICATE', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE');
  });

  it('maps a foreign-key violation to FOREIGN_KEY_VIOLATION', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('fk violation'), { code: '23503' });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FOREIGN_KEY_VIOLATION');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    expect(result.error.message).toContain('connection reset');
  });
});

// ─── findByAggregatorId ─────────────────────────────────────────────────────

describe('PostgresAggregatorProfileStore.findByAggregatorId', () => {
  it('returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ aggregatorId: 'agg-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.findByAggregatorId('agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.aggregatorId).toBe('agg-1');
  });

  it('returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.findByAggregatorId('missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.findByAggregatorId('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update / markCompleted ─────────────────────────────────────────────────

describe('PostgresAggregatorProfileStore.update', () => {
  it('includes only the fields that were provided, plus updatedBy/updatedAt', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ contactName: 'Bob' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    await store.update('agg-1', { contactName: 'Bob', updatedBy: 'tester' });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ contactName: 'Bob', updatedBy: 'tester' });
    expect(set).not.toHaveProperty('personas');
    expect(set).not.toHaveProperty('profileCompletedAt');
    expect(set).toHaveProperty('updatedAt');
  });

  it('includes every settable field when the full patch is provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    await store.update('agg-1', {
      contactName: 'Carl',
      personas: [],
      services: [],
      verifiedCertificate: [],
      profileCompletedAt: new Date('2026-02-01T00:00:00Z'),
      updatedBy: 'tester',
    });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual(
      [
        'contactName',
        'personas',
        'services',
        'verifiedCertificate',
        'profileCompletedAt',
        'updatedBy',
        'updatedAt',
      ].sort(),
    );
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.update('missing', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('dup'), { code: '23505' });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.update('agg-1', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE');
  });

  it('markCompleted delegates to update with profileCompletedAt set', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ profileCompletedAt: new Date() })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.markCompleted('agg-1', 'tester');
    expect(result.ok).toBe(true);
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set.profileCompletedAt).toBeInstanceOf(Date);
    expect(set.updatedBy).toBe('tester');
  });
});

// ─── deleteByAggregatorId ───────────────────────────────────────────────────

describe('PostgresAggregatorProfileStore.deleteByAggregatorId', () => {
  it('returns ok(void) on success', async () => {
    const db = makeFakeDb(() => [makeRow()]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.deleteByAggregatorId('agg-1');
    expect(result.ok).toBe(true);
  });

  it('returns NOT_FOUND when nothing was deleted', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.deleteByAggregatorId('missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorProfileStore();

    const result = await store.deleteByAggregatorId('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});
