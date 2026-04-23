/**
 * Drizzle-ORM client factory for the Postgres adapter.
 *
 * Wraps a pg.Pool into a typed NodePgDatabase instance bound to the aggregator
 * schema. Pass the returned DrizzleDB to repository constructors or use it
 * within transaction callbacks via drizzle's tx object.
 *
 * @module @aggregator-dpg/db/postgres (internal)
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from '../schema/index.js';

/** Typed Drizzle database client bound to the aggregator schema. */
export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a Drizzle client from an existing pg.Pool.
 *
 * @param pool - An already-configured pg.Pool instance.
 * @returns Typed DrizzleDB ready for query building.
 */
export function createDrizzle(pool: Pool): DrizzleDB {
  return drizzle(pool, { schema });
}
