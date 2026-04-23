/**
 * Unit tests for PostgresDBService.transaction().
 *
 * Tests verify the public contract: return value propagation, error re-throw,
 * and UoW shape. BEGIN/COMMIT/ROLLBACK mechanics are drizzle internals covered
 * by integration tests in transaction.integration.test.ts.
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg');

import { Pool } from 'pg';
import { PostgresDBService } from '../postgres/index.js';
import type { DrizzleUoW } from '../postgres/uow.js';
import type { DbConfig } from '../config.schema.js';

const BASE_CONFIG: DbConfig = {
  connectionUrl: 'postgres://user:pass@localhost:5432/test',
  poolSize: 5,
  statementTimeoutMs: 10_000,
  healthcheckTimeoutMs: 3_000,
};

function makeMockPool() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };

  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 1,
  };

  vi.mocked(Pool).mockImplementation(() => mockPool as unknown as Pool);
  return { mockPool, mockClient };
}

describe('PostgresDBService — transaction', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the callback return value on success', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    const result = await db.transaction(async () => 'done');
    expect(result).toBe('done');
  });

  it('re-throws errors from the callback', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await expect(
      db.transaction(async () => {
        throw new Error('business error');
      }),
    ).rejects.toThrow('business error');
  });

  it('uow carries a non-empty transactionId', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db.transaction(async (uow) => {
      expect(typeof uow.transactionId).toBe('string');
      expect(uow.transactionId.length).toBeGreaterThan(0);
    });
  });

  it('uow exposes typed repo handles (DrizzleUoW)', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db.transaction(async (uow) => {
      const typed = uow as DrizzleUoW;
      expect(typed.auditLog).toBeDefined();
      expect(typed.aggregatorProfile).toBeDefined();
      expect(typed.aggregatorProfileSchema).toBeDefined();
      expect(typed.onboardingLink).toBeDefined();
      expect(typed.bulkUploadBatch).toBeDefined();
      expect(typed.bulkUploadRow).toBeDefined();
      expect(typed.registrationRequest).toBeDefined();
      expect(typed.exportJob).toBeDefined();
    });
  });

  it('each transaction gets a unique transactionId', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    const ids: string[] = [];
    await db.transaction(async (uow) => {
      ids.push(uow.transactionId);
    });
    await db.transaction(async (uow) => {
      ids.push(uow.transactionId);
    });
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('PostgresDBService — pool metrics', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns pool counts from the underlying pool', () => {
    const mockPool = {
      connect: vi.fn(),
      end: vi.fn(),
      query: vi.fn(),
      totalCount: 10,
      idleCount: 6,
      waitingCount: 2,
    };
    vi.mocked(Pool).mockImplementation(() => mockPool as unknown as Pool);

    const db = new PostgresDBService(BASE_CONFIG);
    const metrics = db.getPoolMetrics();
    expect(metrics).toEqual({ total: 10, idle: 6, waiting: 2 });
  });
});
