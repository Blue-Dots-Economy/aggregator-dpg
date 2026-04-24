/**
 * Thin pg.Pool factory and metrics type for the Postgres adapter.
 *
 * Kept separate so pool creation is testable without constructing the full
 * PostgresDBService.
 *
 * @module @aggregator-dpg/db/postgres (internal)
 */

import { Pool } from 'pg';
import type { DbConfig } from '../config.schema.js';

/**
 * Point-in-time snapshot of pool connection counts.
 */
export type PoolMetrics = {
  /** Total connections managed by the pool (active + idle). */
  total: number;
  /** Connections currently idle and available. */
  idle: number;
  /** Client requests waiting for a free connection. */
  waiting: number;
};

/**
 * Creates and configures a pg.Pool from a validated DbConfig slice.
 *
 * @param config - Validated db config slice from config-loader.
 * @returns Configured pg.Pool instance (not yet connected).
 */
export function createPool(config: DbConfig): Pool {
  return new Pool({
    connectionString: config.url,
    max: config.poolSize,
    statement_timeout: config.statementTimeoutMs,
    ssl: config.ssl,
  });
}
