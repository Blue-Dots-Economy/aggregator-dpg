/**
 * Drizzle schema root for the aggregator-dpg database.
 *
 * Table definitions are added here as each entity is introduced (F-04.4+).
 * Run `pnpm --filter @aggregator-dpg/db migrate:generate` after any change
 * to produce a migration file under migrations/.
 *
 * @module @aggregator-dpg/db/schema
 */

export * from './aggregator.js';
