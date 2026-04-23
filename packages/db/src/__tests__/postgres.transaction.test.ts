import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('pg');

import { Pool } from 'pg';
import { PostgresDBService } from '../postgres/index.js';
import type { DbConfig } from '../config.schema.js';

const BASE_CONFIG: DbConfig = {
  connectionUrl: 'postgres://user:pass@localhost:5432/test',
  poolSize: 5,
  statementTimeoutMs: 10_000,
  healthcheckTimeoutMs: 3_000,
};

function makeMockPool() {
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };

  const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
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

  it('runs BEGIN, callback, COMMIT on success', async () => {
    const { mockClient } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    const result = await db.transaction(async (uow) => {
      expect(uow.transactionId).toBeTruthy();
      return 'done';
    });
    expect(result).toBe('done');
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('runs ROLLBACK and re-throws on callback error', async () => {
    const { mockClient } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await expect(
      db.transaction(async () => {
        throw new Error('business error');
      }),
    ).rejects.toThrow('business error');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('releases client after commit', async () => {
    const { mockClient } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db.transaction(async () => 'ok');
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('releases client after rollback', async () => {
    const { mockClient } = makeMockPool();
    const db = new PostgresDBService(BASE_CONFIG);
    await db
      .transaction(async () => {
        throw new Error('fail');
      })
      .catch(() => {});
    expect(mockClient.release).toHaveBeenCalledOnce();
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
