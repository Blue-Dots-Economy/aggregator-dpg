/**
 * Postgres implementation of DBService.
 *
 * Backed by a pg.Pool. Call close() on process shutdown to drain the pool.
 * Import via the ./postgres subpath — never import from src/postgres directly.
 *
 * @module @aggregator-dpg/db/postgres
 */

import type { Pool } from 'pg';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError } from '@aggregator-dpg/shared-primitives/errors';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type { UnitOfWork } from '../interface.js';
import { DBService } from '../interface.js';
import type { DbConfig } from '../config.schema.js';
import { createPool } from './pool.js';
import type { PoolMetrics } from './pool.js';
import { createDrizzle } from './drizzle.js';
import type { DrizzleDB } from './drizzle.js';
import { withTransaction } from './transaction.js';
import type { DrizzleUoW } from './uow.js';

export type { PoolMetrics } from './pool.js';
export type { DrizzleUoW } from './uow.js';

/**
 * Postgres-backed database service.
 *
 * @example
 * const db = new PostgresDBService(config.slice<DbConfig>('db'));
 * await db.healthcheck();
 * const stopWatching = () => db.close();
 */
export class PostgresDBService extends DBService {
  private readonly pool: Pool;
  private readonly db: DrizzleDB;
  private readonly healthcheckTimeoutMs: number;

  /**
   * @param config - Validated db config slice from config-loader.
   */
  constructor(config: DbConfig) {
    super();
    this.healthcheckTimeoutMs = config.healthcheckTimeoutMs;
    this.pool = createPool(config);
    this.db = createDrizzle(this.pool);
  }

  /**
   * Verifies the database is reachable by running `SELECT 1` within the
   * configured healthcheck timeout.
   *
   * @returns Ok(void) on success, Err(UpstreamError) on failure or timeout.
   */
  async healthcheck(): Promise<Result<void, BaseError>> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`healthcheck timed out after ${this.healthcheckTimeoutMs} ms`)),
        this.healthcheckTimeoutMs,
      ),
    );

    const check = async (): Promise<Result<void, BaseError>> => {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        return ok(undefined);
      } finally {
        client.release();
      }
    };

    try {
      return await Promise.race([check(), timeout]);
    } catch (e) {
      return err(
        new UpstreamError('DB healthcheck failed', {
          code: 'DB_HEALTHCHECK_FAILED',
          details: { cause: String(e) },
        }),
      );
    }
  }

  /**
   * Drains the connection pool and releases all resources.
   * Call once on process shutdown.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Runs work inside a single Postgres transaction.
   *
   * Commits on success; rolls back and re-throws on any error. Nested calls
   * automatically use SAVEPOINTs — the outer transaction is not affected by
   * an inner rollback that is caught by the caller.
   *
   * @param fn - Callback receiving a DrizzleUoW with per-entity repo handles.
   */
  async transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return withTransaction(this.db, fn as (uow: DrizzleUoW) => Promise<T>);
  }

  /**
   * Returns a point-in-time snapshot of pool connection counts.
   *
   * Useful for health dashboards and observability hooks.
   */
  getPoolMetrics(): PoolMetrics {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}
