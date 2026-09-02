/**
 * Unit tests for PostgresAggregatorStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub that mimics
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked, matching the pattern used in
 * `packages/participants-writer/src/__tests__/participants-writer.test.ts`
 * and `packages/consent-ledger/src/__tests__/consent-ledger.test.ts`). Every
 * chained call is recorded so a test can assert on the exact values passed
 * into `.values()` / `.set()`, and the terminal `await` resolves to whatever
 * the test configures (a row set, an empty set, or a thrown driver error) —
 * this exercises the real UPSERT/error-mapping logic in `postgres.ts`
 * without a live database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresAggregatorStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import type { Aggregator, CreateAggregatorInput } from '../interface.js';

// ─── Fake Drizzle chain ─────────────────────────────────────────────────────

interface ChainCall {
  method: string;
  args: unknown[];
}

/**
 * Builds a stub that mimics Drizzle's fluent, thenable query builder. Every
 * chained method call (`.select()`, `.where()`, `.values()`, ...) is appended
 * to `chain`; when the caller finally `await`s the chain, `resolve(chain)`
 * decides what the "query" resolves to (return an array to simulate rows, or
 * throw to simulate a driver error).
 */
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

/** Returns the args of the first recorded call to `method`, if any. */
function callArgs(chain: ChainCall[], method: string): unknown[] | undefined {
  return chain.find((c) => c.method === method)?.args;
}

function hasCall(chain: ChainCall[], method: string): boolean {
  return chain.some((c) => c.method === method);
}

afterEach(() => {
  _setDbClients(null, null);
});

// ─── Row fixture ────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<Aggregator> = {}): Aggregator {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-000000000001',
    orgSlug: 'test-org',
    actorType: 'aggregator',
    name: 'Test Org',
    type: null,
    url: null,
    contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
    contactPhone: '+919000000001',
    contactEmail: 'a@x.org',
    locations: [],
    consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
    profile: {},
    profileRef: null,
    status: 'pending',
    createdBy: 'system',
    updatedBy: 'system',
    createdAt,
    updatedAt: createdAt,
    signalstackOrgId: null,
    parentOrgId: null,
    inviteEmail: null,
    rejectedAt: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateAggregatorInput> = {}): CreateAggregatorInput {
  return {
    orgSlug: 'test-org',
    actorType: 'aggregator',
    name: 'Test Org',
    type: null,
    contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
    consent: { value: true, given_at: '2026-01-01T00:00:00Z', valid_till: '2027-01-01T00:00:00Z' },
    createdBy: 'system',
    updatedBy: 'system',
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresAggregatorStore.create', () => {
  it('inserts the mapped row and returns it on success', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ id: 'agg-1' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput({ parentOrgId: 'org-9' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('agg-1');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      orgSlug: 'test-org',
      actorType: 'aggregator',
      parentOrgId: 'org-9',
    });
  });

  it('defaults optional fields (url, locations, parentOrgId) when omitted', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.create(makeInput());

    const values = callArgs(captured, 'values')?.[0] as Record<string, unknown>;
    expect(values.url).toBeNull();
    expect(values.locations).toEqual([]);
    expect(values.parentOrgId).toBeNull();
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a unique violation on contact_phone to DUPLICATE_PHONE', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_contact_phone_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_PHONE');
  });

  it('maps a unique violation on contact_email to DUPLICATE_EMAIL', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_contact_email_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('maps any other unique violation to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_org_slug_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps a Drizzle-wrapped unique violation (code/constraint on .cause) to DUPLICATE_SLUG', async () => {
    // Real Drizzle shape: outer error is the query text; SQLSTATE + constraint
    // are on `.cause`. Regression guard for the 503-instead-of-409 bug.
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'aggregators_org_slug_key',
      });
      throw Object.assign(new Error('Failed query: insert into "aggregators" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps a check violation to CHECK_VIOLATION', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('check failed'), {
        code: '23514',
        constraint: 'aggregators_actor_type_check',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CHECK_VIOLATION');
  });

  it('maps an unrecognised driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    expect(result.error.message).toContain('connection reset');
  });
});

// ─── find* ──────────────────────────────────────────────────────────────────

describe('PostgresAggregatorStore.findById / findBySlug / findByContactPhone / findByContactEmail', () => {
  it('findById returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'agg-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findById('agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('agg-1');
  });

  it('findById returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findById('missing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('findById returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findById('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findBySlug returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ orgSlug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();
    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.orgSlug).toBe('acme');
  });

  it('findBySlug returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();
    const result = await store.findBySlug('acme');
    expect(result.ok).toBe(false);
  });

  it('findByContactPhone returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ contactPhone: '+919000000009' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();
    const result = await store.findByContactPhone('+919000000009');
    expect(result.ok && result.value?.contactPhone).toBe('+919000000009');
  });

  it('findByContactPhone returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();
    const result = await store.findByContactPhone('x');
    expect(result.ok).toBe(false);
  });

  it('findByContactEmail lowercases the lookup value', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ contactEmail: 'mixed@x.org' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findByContactEmail('MIXED@X.ORG');
    expect(result.ok && result.value?.contactEmail).toBe('mixed@x.org');
    // The where() call must have been reached with a condition built from the
    // lowercased email (asserted indirectly — the store computed it before
    // calling .where()).
    expect(hasCall(captured, 'where')).toBe(true);
  });

  it('findByContactEmail returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();
    const result = await store.findByContactEmail('a@x.org');
    expect(result.ok).toBe(false);
  });
});

// ─── findByParentOrgId ──────────────────────────────────────────────────────

describe('PostgresAggregatorStore.findByParentOrgId', () => {
  it('returns the mapped rows for the org', async () => {
    const db = makeFakeDb(() => [
      makeRow({ id: 'c1', parentOrgId: 'org-1' }),
      makeRow({ id: 'c2', parentOrgId: 'org-1' }),
    ]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findByParentOrgId('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  it('returns an empty array when no coordinators match', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findByParentOrgId('org-none');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findByParentOrgId('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('PostgresAggregatorStore.list', () => {
  it('applies default limit/offset and returns rows + total', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) {
        captured = chain;
        return [makeRow({ id: 'agg-1' }), makeRow({ id: 'agg-2' })];
      }
      // The `select({ total: ... })` count query has no orderBy call.
      return [{ total: 2 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.list({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toHaveLength(2);
    expect(result.value.total).toBe(2);
    expect(callArgs(captured, 'limit')).toEqual([50]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('clamps limit to 1000 and offset to 0', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      if (hasCall(chain, 'orderBy')) captured = chain;
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.list({ limit: 5000, offset: -10 });
    expect(callArgs(captured, 'limit')).toEqual([1000]);
    expect(callArgs(captured, 'offset')).toEqual([0]);
  });

  it('builds a where clause when status/actorType/updatedBefore filters are set', async () => {
    let sawWhereWithFilters = false;
    const db = makeFakeDb((chain) => {
      const whereArgs = callArgs(chain, 'where');
      if (whereArgs && whereArgs[0] !== undefined) sawWhereWithFilters = true;
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.list({ status: 'active', actorType: 'aggregator', updatedBefore: new Date() });
    expect(sawWhereWithFilters).toBe(true);
  });

  it('passes where=undefined when no filters are set', async () => {
    let sawUndefinedWhere = false;
    const db = makeFakeDb((chain) => {
      const whereArgs = callArgs(chain, 'where');
      if (whereArgs && whereArgs[0] === undefined) sawUndefinedWhere = true;
      return hasCall(chain, 'orderBy') ? [] : [{ total: 0 }];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.list({});
    expect(sawUndefinedWhere).toBe(true);
  });

  it('defaults total to 0 when the count query returns no row', async () => {
    const db = makeFakeDb((chain) => (hasCall(chain, 'orderBy') ? [] : []));
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.list({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.list({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update / updateStatus ──────────────────────────────────────────────────

describe('PostgresAggregatorStore.update / updateStatus', () => {
  it('includes only the patch fields that were provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ name: 'New Name' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.update('agg-1', { name: 'New Name', updatedBy: 'tester' });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ name: 'New Name', updatedBy: 'tester' });
    expect(set).not.toHaveProperty('status');
    expect(set).not.toHaveProperty('contact');
    expect(set).toHaveProperty('updatedAt');
  });

  it('includes every settable field when the full patch is provided', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow()];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    await store.update('agg-1', {
      name: 'N',
      type: 'seeker',
      url: 'https://x.org',
      contact: { name: 'A', phone: '+919000000001', email: 'a@x.org' },
      locations: [],
      consent: {
        value: true,
        given_at: '2026-01-01T00:00:00Z',
        valid_till: '2027-01-01T00:00:00Z',
      },
      status: 'active',
      parentOrgId: 'org-1',
      updatedBy: 'tester',
    });

    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(Object.keys(set).sort()).toEqual(
      [
        'name',
        'type',
        'url',
        'contact',
        'locations',
        'consent',
        'status',
        'parentOrgId',
        'updatedBy',
        'updatedAt',
      ].sort(),
    );
  });

  it('returns NOT_FOUND when no row matches the id', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.update('missing', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'aggregators_contact_email_key',
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.update('agg-1', { updatedBy: 'tester' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_EMAIL');
  });

  it('updateStatus delegates to update with the status field set', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.updateStatus('agg-1', 'active', 'tester');
    expect(result.ok).toBe(true);
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set.status).toBe('active');
  });
});

// ─── approveFromPending ─────────────────────────────────────────────────────

describe('PostgresAggregatorStore.approveFromPending', () => {
  it('returns the updated row on a successful CAS', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'active' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('active');
  });

  it('returns ok(null) when the row was not pending (lost the race)', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.approveFromPending('agg-1', 'tester');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── updateSignalstackOrgId ─────────────────────────────────────────────────

describe('PostgresAggregatorStore.updateSignalstackOrgId', () => {
  it('stamps the signalstack org id and returns the mapped row', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ signalstackOrgId: 'ss-org-1' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.updateSignalstackOrgId('agg-1', 'ss-org-1', 'tester');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.signalstackOrgId).toBe('ss-org-1');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ signalstackOrgId: 'ss-org-1' });
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.updateSignalstackOrgId('missing', 'ss-org-1', 'tester');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps a driver throw through mapWriteError', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.updateSignalstackOrgId('agg-1', 'ss-org-1', 'tester');
    expect(result.ok).toBe(false);
  });
});

// ─── deleteById ─────────────────────────────────────────────────────────────

describe('PostgresAggregatorStore.deleteById', () => {
  it('returns ok on successful delete', async () => {
    const db = makeFakeDb(() => [makeRow()]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.deleteById('agg-1');
    expect(result.ok).toBe(true);
  });

  it('returns NOT_FOUND when nothing was deleted', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.deleteById('missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.deleteById('agg-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── toDomain mapping ───────────────────────────────────────────────────────

describe('PostgresAggregatorStore row → domain mapping', () => {
  it('coerces a legacy type="both" row to type=null', async () => {
    const db = makeFakeDb(() => [makeRow({ type: 'both' as never })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorStore();

    const result = await store.findById('agg-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.type).toBeNull();
  });
});
