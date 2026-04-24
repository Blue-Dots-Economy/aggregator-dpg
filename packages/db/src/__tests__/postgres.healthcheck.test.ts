import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg');

import { Pool } from 'pg';
import { PostgresDBService } from '../postgres/index.js';
import type { DbConfig } from '../config.schema.js';

const BASE_CONFIG: DbConfig = {
  url: 'postgres://user:pass@localhost:5432/test',
  poolSize: 5,
  statementTimeoutMs: 10_000,
  healthcheckTimeoutMs: 3_000,
  migrationsTable: '__drizzle_migrations',
  ssl: false,
};

function makeMockPool(
  overrides: Partial<{
    connectErr: Error;
    queryErr: Error;
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  }> = {},
) {
  const mockClient = {
    query: overrides.queryErr
      ? vi.fn().mockRejectedValue(overrides.queryErr)
      : vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    release: vi.fn(),
  };

  const mockPool = {
    connect: overrides.connectErr
      ? vi.fn().mockRejectedValue(overrides.connectErr)
      : vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    totalCount: overrides.totalCount ?? 5,
    idleCount: overrides.idleCount ?? 3,
    waitingCount: overrides.waitingCount ?? 1,
  };

  vi.mocked(Pool).mockImplementation(() => mockPool as unknown as Pool);
  return { mockPool, mockClient };
}

describe('PostgresDBService — healthcheck', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns ok when SELECT 1 succeeds', async () => {
    makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    const result = await db.healthcheck();
    expect(result.success).toBe(true);
  });

  it('releases the client after a successful check', async () => {
    const { mockClient } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db.healthcheck();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('returns err(UpstreamError) when query throws', async () => {
    makeMockPool({ queryErr: new Error('connection refused') });
    const db = new PostgresDBService(BASE_CONFIG);
    const result = await db.healthcheck();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe('UpstreamError');
      expect(result.error.message).toContain('healthcheck failed');
    }
  });

  it('returns err(UpstreamError) when connect throws', async () => {
    makeMockPool({ connectErr: new Error('no connections available') });
    const db = new PostgresDBService(BASE_CONFIG);
    const result = await db.healthcheck();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe('UpstreamError');
    }
  });

  it('returns err when healthcheck exceeds timeout', async () => {
    vi.useFakeTimers();
    const mockClient = {
      query: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    };
    vi.mocked(Pool).mockImplementation(() => mockPool as unknown as Pool);

    const db = new PostgresDBService({ ...BASE_CONFIG, healthcheckTimeoutMs: 100 });
    const resultPromise = db.healthcheck();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('healthcheck failed');
    }
    vi.useRealTimers();
  });

  it('close() calls pool.end()', async () => {
    const { mockPool } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db.close();
    expect(mockPool.end).toHaveBeenCalledOnce();
  });
});
