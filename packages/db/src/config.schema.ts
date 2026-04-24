/**
 * Runtime configuration schema for the db package.
 *
 * Validates the `db` slice of the merged config tree. Discovered and applied
 * by config-loader at boot via the ./config subpath export convention.
 *
 * @module @aggregator-dpg/db/config
 */

import { z } from 'zod';

/**
 * Shape of the `db` config slice.
 */
export const DbConfigSchema = z.object({
  /**
   * Full Postgres connection URL. Must be supplied via DATABASE_URL env var
   * in production; config-loader interpolates `${DATABASE_URL}` before Zod runs.
   * Example: postgres://user:pass@localhost:5432/aggregator
   */
  url: z.string().url(),
  /** Maximum number of clients in the pool. */
  poolSize: z.number().int().positive(),
  /** Milliseconds before a query is cancelled by the server. */
  statementTimeoutMs: z.number().int().positive(),
  /** Milliseconds before a healthcheck SELECT 1 is considered failed. */
  healthcheckTimeoutMs: z.number().int().positive(),
  /** Table used by drizzle-kit to track applied migrations. */
  migrationsTable: z.string().min(1),
  /**
   * Enable TLS for the connection. Default `false` for local dev.
   * Production / managed Postgres: set to `true` via env-specific override.
   */
  ssl: z.boolean(),
});

export type DbConfig = z.infer<typeof DbConfigSchema>;

/**
 * Top-level key under which this package's config lives in the merged config tree.
 */
export const configKey = 'db';

/**
 * Zod schema that validates the db config slice.
 * Discovered and applied by config-loader at boot.
 */
export const configSchema = DbConfigSchema;

/**
 * Baseline db config. `url` is resolved from DATABASE_URL env var at boot —
 * the interpolation pipeline replaces the placeholder before Zod runs.
 *
 * Local-dev defaults: small pool, lenient timeouts, TLS off. Per-environment
 * overrides live in config/env/{dev,staging,prod}.yaml.
 */
export const configDefaults: DbConfig = {
  url: '${DATABASE_URL}',
  poolSize: 10,
  statementTimeoutMs: 30_000,
  healthcheckTimeoutMs: 5_000,
  migrationsTable: '__drizzle_migrations',
  ssl: false,
};

export type Config = DbConfig;
