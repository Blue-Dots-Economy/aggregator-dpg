/**
 * Migration runner.
 *
 * Invoked via `pnpm --filter @aggregator-dpg/api db:migrate` to apply all
 * Drizzle migrations in `drizzle/migrations/` against the configured Postgres
 * instance. Safe to run repeatedly — Drizzle records applied migrations in
 * its own metadata table.
 *
 * Production startup also calls `runMigrations()` programmatically before
 * `app.listen()` to keep the schema in lockstep with the deployed code.
 *
 * Concurrent runners (several API replicas booting at once, or a replica plus
 * a manual `db:migrate`) are serialised on a session-level advisory lock.
 * Drizzle reads the list of applied migrations BEFORE it opens its own
 * transaction, so without the lock a second runner can decide to re-apply a
 * migration the first one has just committed — e.g. re-run 0025 after 0026
 * dropped the columns it touches, or race on creating the metadata table.
 */

import '../env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { closeDb, getDb, getPool } from './client.js';
import { logger } from '../logger.js';
import { runMigrationGuards } from './migration-guards.js';
import { MIGRATION_LOCK_SQL_KEY, migrateWithLock as migrateWithLockCore } from './migrate-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { MIGRATION_LOCK_SQL_KEY };

/**
 * Applies all pending migrations in `migrationsFolder` under the migration
 * advisory lock (`migrate-core.ts`), logging through the app logger.
 *
 * @param db - Drizzle client the migrations run through.
 * @param pool - Pool the lock connection is taken from (normally the one `db` wraps).
 * @param migrationsFolder - Folder holding the `.sql` files and `meta/_journal.json`.
 */
export async function migrateWithLock<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  await migrateWithLockCore(db, pool, migrationsFolder, logger);
}

/**
 * Applies all pending migrations under the migration advisory lock, after the
 * pre-migration guards (`migration-guards.ts`).
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle/migrations');
  logger.info({ migrationsFolder }, 'running database migrations');
  // Refuse foreign migrations, and the user & org instance upgrade on a
  // database with data (that path is the migration tool's; see
  // migration-guards.ts). Read once here, at startup.
  await runMigrationGuards(getPool(), migrationsFolder, process.env.ALLOW_TRAIN_ON_BOOT === 'true');
  await migrateWithLock(getDb(), getPool(), migrationsFolder);
  logger.info('database migrations applied');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await runMigrations();
    await closeDb();
    process.exit(0);
  } catch (err: unknown) {
    logger.error({ err }, 'migration failed');
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}
