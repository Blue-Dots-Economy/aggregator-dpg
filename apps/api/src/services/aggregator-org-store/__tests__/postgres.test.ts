/**
 * Unit tests for PostgresAggregatorOrgStore.
 *
 * The Drizzle client (`getDb()`) is swapped for a hand-built stub mimicking
 * its fluent, thenable query-builder chain (per testing.md §1 — third-party
 * adapters may be stubbed rather than faked), matching the pattern in
 * `packages/participants-writer/src/__tests__/participants-writer.test.ts`.
 * Every chained call is recorded so a test can assert on the exact values
 * passed into `.values()` / `.set()`, and the terminal `await` resolves to
 * whatever the test configures — this exercises the real
 * insert/CAS-approve/error-mapping logic in `postgres.ts` without a live
 * database.
 *
 * @module @aggregator-dpg/api
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresAggregatorOrgStore } from '../postgres.js';
import { _setDbClients } from '../../../db/client.js';
import type { AggregatorOrg, CreateOrgInput } from '../interface.js';

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

function makeRow(overrides: Partial<AggregatorOrg> = {}): AggregatorOrg {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    ownerEmail: 'owner@test.local',
    ownerPhone: null,
    ownerKcSub: null,
    kcGroupId: null,
    profile: {},
    profileRef: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CreateOrgInput> = {}): CreateOrgInput {
  return {
    slug: 'test-org',
    displayName: 'Test Org',
    ownerEmail: 'owner@test.local',
    ...overrides,
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

describe('PostgresAggregatorOrgStore.create', () => {
  it('inserts the mapped row, lowercasing the owner email', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ ownerEmail: 'owner@test.local' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput({ ownerEmail: 'OWNER@TEST.LOCAL' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerEmail).toBe('owner@test.local');
    expect(callArgs(captured, 'values')?.[0]).toMatchObject({
      slug: 'test-org',
      displayName: 'Test Org',
      ownerEmail: 'owner@test.local',
      state: null,
      ownerPhone: null,
      ownerKcSub: null,
      kcGroupId: null,
    });
  });

  it('returns DB_UNAVAILABLE when insert returns no row', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('maps a display-name unique violation to DUPLICATE_NAME', async () => {
    const db = makeFakeDb(() => {
      throw new Error(
        'duplicate key value violates unique constraint "aggregator_orgs_display_name_active_unique"',
      );
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug unique violation to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      throw new Error(
        'duplicate key value violates unique constraint "aggregator_orgs_slug_active_unique"',
      );
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps a display-name violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_NAME', async () => {
    // Real Drizzle shape: outer `.message` is the query text; the pg driver
    // error (SQLSTATE 23505 + `constraint`) is on `.cause`. Regression guard
    // for the 503-instead-of-409 misclassification.
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(
        new Error(
          'duplicate key value violates unique constraint "aggregator_orgs_display_name_active_unique"',
        ),
        { code: '23505', constraint: 'aggregator_orgs_display_name_active_unique' },
      );
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_NAME');
  });

  it('maps a slug violation wrapped by Drizzle (constraint on .cause) to DUPLICATE_SLUG', async () => {
    const db = makeFakeDb(() => {
      const pgErr = Object.assign(new Error('duplicate key value ...'), {
        code: '23505',
        constraint: 'aggregator_orgs_slug_active_unique',
      });
      throw Object.assign(new Error('Failed query: insert into "aggregator_orgs" ...'), {
        cause: pgErr,
      });
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DUPLICATE_SLUG');
  });

  it('maps any other driver error to DB_UNAVAILABLE', async () => {
    const db = makeFakeDb(() => {
      throw new Error('connection reset');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.create(makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
    expect(result.error.message).toContain('connection reset');
  });
});

// ─── findById / findBySlug / findByOwnerEmail (findOne) ────────────────────

describe('PostgresAggregatorOrgStore.findById / findBySlug / findByOwnerEmail', () => {
  it('findById returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.id).toBe('org-1');
  });

  it('findById returns null when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

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
    const store = new PostgresAggregatorOrgStore();

    const result = await store.findById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });

  it('findBySlug returns the mapped row when found', async () => {
    const db = makeFakeDb(() => [makeRow({ slug: 'acme' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();
    const result = await store.findBySlug('acme');
    expect(result.ok && result.value?.slug).toBe('acme');
  });

  it('findByOwnerEmail lowercases the lookup value and returns the mapped row', async () => {
    const db = makeFakeDb(() => [makeRow({ ownerEmail: 'mixed@x.org' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.findByOwnerEmail('MIXED@X.ORG');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.ownerEmail).toBe('mixed@x.org');
  });

  it('findByOwnerEmail returns DB_UNAVAILABLE on driver throw', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.findByOwnerEmail('a@x.org');
    expect(result.ok).toBe(false);
  });
});

// ─── listActive / listPending ───────────────────────────────────────────────

describe('PostgresAggregatorOrgStore.listActive', () => {
  it('returns the mapped active rows', async () => {
    const db = makeFakeDb(() => [makeRow({ id: 'org-1', status: 'active' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.status).toBe('active');
  });

  it('returns an empty array when there are no active orgs', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listActive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listActive();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

describe('PostgresAggregatorOrgStore.listPending', () => {
  it('builds a compound where clause when updatedBefore is given', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ status: 'pending' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listPending(new Date('2026-01-01T00:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(callArgs(captured, 'where')?.[0]).toBeDefined();
  });

  it('filters on status=pending only when updatedBefore is omitted', async () => {
    const db = makeFakeDb(() => [makeRow({ status: 'pending' })]);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listPending();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.listPending();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── update ─────────────────────────────────────────────────────────────────

describe('PostgresAggregatorOrgStore.update', () => {
  it('merges the patch and stamps updatedAt', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ displayName: 'New Name' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.update('org-1', { displayName: 'New Name' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe('New Name');
    const set = callArgs(captured, 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ displayName: 'New Name' });
    expect(set).toHaveProperty('updatedAt');
  });

  it('returns NOT_FOUND when no row matches', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.update('missing', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.update('org-1', { displayName: 'X' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── deleteById ─────────────────────────────────────────────────────────────

describe('PostgresAggregatorOrgStore.deleteById', () => {
  it('returns ok(void) on success', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.deleteById('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});

// ─── approve / reject (casFromPending) ──────────────────────────────────────

describe('PostgresAggregatorOrgStore.approve / reject', () => {
  it('approve returns the updated row on a successful CAS', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ status: 'active' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.approve('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('active');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'active' });
  });

  it('approve returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.approve('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('reject returns the updated row with status=inactive', async () => {
    let captured: ChainCall[] = [];
    const db = makeFakeDb((chain) => {
      captured = chain;
      return [makeRow({ status: 'inactive' })];
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.reject('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value?.status).toBe('inactive');
    expect(callArgs(captured, 'set')?.[0]).toMatchObject({ status: 'inactive' });
  });

  it('reject returns ok(null) when the row was not pending', async () => {
    const db = makeFakeDb(() => []);
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.reject('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it('returns DB_UNAVAILABLE when the driver throws', async () => {
    const db = makeFakeDb(() => {
      throw new Error('boom');
    });
    _setDbClients(null, db as never);
    const store = new PostgresAggregatorOrgStore();

    const result = await store.approve('org-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DB_UNAVAILABLE');
  });
});
