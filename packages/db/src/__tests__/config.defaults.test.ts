/**
 * Drift test — verifies that config.defaults.yaml stays consistent with the
 * TypeScript configDefaults constant. Both represent the same contract; if
 * one changes without the other, this test fails.
 *
 * @module @aggregator-dpg/db/__tests__
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { configDefaults, DbConfigSchema } from '../config.schema.js';

const YAML_PATH = resolve(import.meta.dirname, '../../config.defaults.yaml');

describe('config.defaults.yaml', () => {
  it('parses as valid YAML with a top-level `db` key', () => {
    const raw = readFileSync(YAML_PATH, 'utf8');
    const parsed = load(raw) as { db?: Record<string, unknown> };
    expect(parsed).toBeDefined();
    expect(parsed.db).toBeDefined();
  });

  it('matches configDefaults exactly', () => {
    const raw = readFileSync(YAML_PATH, 'utf8');
    const parsed = load(raw) as { db: Record<string, unknown> };
    expect(parsed.db).toEqual(configDefaults);
  });

  it('passes DbConfigSchema once url placeholder is resolved', () => {
    const raw = readFileSync(YAML_PATH, 'utf8');
    const parsed = load(raw) as { db: Record<string, unknown> };
    const withUrl = {
      ...parsed.db,
      url: 'postgres://user:pass@localhost:5432/test',
    };
    expect(DbConfigSchema.safeParse(withUrl).success).toBe(true);
  });
});
