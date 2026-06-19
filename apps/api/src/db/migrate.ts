/**
 * Migration runner.
 *
 * Invoked via `pnpm --filter @aggregator-dpg/api db:migrate` to apply all
 * Drizzle migrations in `drizzle/migrations/` against the configured Postgres
 * instance. Safe to run repeatedly — Drizzle records applied migrations in
 * its own metadata table.
 *
 * Production startup may also call `runMigrations()` programmatically before
 * `app.listen()` to keep the schema in lockstep with the deployed code.
 */

import '../env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies all pending migrations.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.resolve(__dirname, '../../drizzle/migrations');
  logger.info({ migrationsFolder }, 'running database migrations');
  await migrate(getDb(), { migrationsFolder });
  logger.info('database migrations applied');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrations()
    .then(async () => {
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
