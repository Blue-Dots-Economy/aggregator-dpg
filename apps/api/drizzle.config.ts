import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration. Used by `db:generate`, `db:push`, `db:studio`
 * scripts to introspect and migrate the local Postgres instance.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgres://aggregator:aggregator-dev@localhost:5433/aggregator',
  },
  strict: true,
  verbose: true,
});
