/**
 * Drizzle Kit configuration for the db package.
 *
 * - Schema source: src/schema/index.ts
 * - Migration output: migrations/
 * - Driver: pg (node-postgres)
 *
 * DATABASE_URL must be set when running migrate:up or migrate:status.
 * migrate:generate does NOT require a live database.
 *
 * @module @aggregator-dpg/db (drizzle config)
 */

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
