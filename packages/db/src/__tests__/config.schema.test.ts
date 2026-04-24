/**
 * Unit tests for the db config schema and defaults.
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { describe, it, expect } from 'vitest';
import { DbConfigSchema, configDefaults, configKey, configSchema } from '../config.schema.js';

describe('DbConfigSchema', () => {
  it('accepts a valid config with all required keys', () => {
    const result = DbConfigSchema.safeParse({
      url: 'postgres://user:pass@localhost:5432/db',
      poolSize: 10,
      statementTimeoutMs: 30_000,
      healthcheckTimeoutMs: 5_000,
      migrationsTable: '__drizzle_migrations',
      ssl: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-URL connection string', () => {
    const result = DbConfigSchema.safeParse({
      url: 'not-a-url',
      poolSize: 10,
      statementTimeoutMs: 30_000,
      healthcheckTimeoutMs: 5_000,
      migrationsTable: '__drizzle_migrations',
      ssl: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive poolSize', () => {
    const result = DbConfigSchema.safeParse({
      url: 'postgres://localhost/db',
      poolSize: 0,
      statementTimeoutMs: 30_000,
      healthcheckTimeoutMs: 5_000,
      migrationsTable: '__drizzle_migrations',
      ssl: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty migrationsTable', () => {
    const result = DbConfigSchema.safeParse({
      url: 'postgres://localhost/db',
      poolSize: 10,
      statementTimeoutMs: 30_000,
      healthcheckTimeoutMs: 5_000,
      migrationsTable: '',
      ssl: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing ssl key', () => {
    const result = DbConfigSchema.safeParse({
      url: 'postgres://localhost/db',
      poolSize: 10,
      statementTimeoutMs: 30_000,
      healthcheckTimeoutMs: 5_000,
      migrationsTable: '__drizzle_migrations',
    });
    expect(result.success).toBe(false);
  });
});

describe('configDefaults', () => {
  it('exposes the ${DATABASE_URL} placeholder for interpolation', () => {
    expect(configDefaults.url).toBe('${DATABASE_URL}');
  });

  it('uses __drizzle_migrations as the default migrations table', () => {
    expect(configDefaults.migrationsTable).toBe('__drizzle_migrations');
  });

  it('defaults ssl to false (safe for local dev)', () => {
    expect(configDefaults.ssl).toBe(false);
  });

  it('passes the schema once the URL placeholder is replaced with a real value', () => {
    const interpolated = {
      ...configDefaults,
      url: 'postgres://user:pass@localhost:5432/aggregator',
    };
    expect(DbConfigSchema.safeParse(interpolated).success).toBe(true);
  });
});

describe('config module exports', () => {
  it('exports configKey = "db"', () => {
    expect(configKey).toBe('db');
  });

  it('exports configSchema = DbConfigSchema', () => {
    expect(configSchema).toBe(DbConfigSchema);
  });
});
