/**
 * Unit tests for the aggregator schema resolver and the `profile_ref` it
 * derives.
 *
 * Since #640 the file it resolves is the published `aggregator-forms.json`,
 * delivered by the mounted schemas tree rather than baked into this repo —
 * so these build a temp tree per case instead of relying on `config/`.
 *
 * The invariant worth protecting is that the ref names the file that actually
 * answered, never `AGGREGATOR_NETWORK`/`AGGREGATOR_BRAND`: lookup falls back to
 * the shared default when an override is absent, so an env-derived ref would
 * claim a brand for a payload that came from the generic form.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSchema, resolveProfileRef } from './schema-ref.js';

const FILE = 'aggregator-forms.json';
const roots: string[] = [];

/** Builds a temp config root holding `aggregator-forms.json` at each scope. */
function rootWith(...scopes: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agg-schema-ref-'));
  roots.push(root);
  for (const scope of scopes) {
    const dir = path.join(root, scope, 'schemas', 'aggregator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, FILE), '{"forms":{}}', 'utf8');
  }
  return root;
}

const env = (CONFIG_ROOT: string, AGGREGATOR_NETWORK: string, AGGREGATOR_BRAND?: string) => ({
  CONFIG_ROOT,
  AGGREGATOR_NETWORK,
  ...(AGGREGATOR_BRAND ? { AGGREGATOR_BRAND } : {}),
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveProfileRef', () => {
  it('names the brand override when the brand ships its own bundle', () => {
    const root = rootWith('', 'blue_dot', 'blue_dot/up-gzb');
    expect(resolveProfileRef(FILE, env(root, 'blue_dot', 'up-gzb'))).toBe(
      'blue_dot/up-gzb/aggregator-forms',
    );
  });

  it('names the network level when no brand is set', () => {
    const root = rootWith('', 'blue_dot');
    expect(resolveProfileRef(FILE, env(root, 'blue_dot'))).toBe('blue_dot/aggregator-forms');
  });

  it('reports the shared default when the network ships no bundle', () => {
    const root = rootWith('');
    expect(resolveProfileRef(FILE, env(root, 'no_such_network'))).toBe('aggregator-forms');
  });

  it('does NOT claim a brand whose override is absent', () => {
    // The whole point of the column: a ref naming a variant the payload did
    // not come from is worse than no ref at all.
    const root = rootWith('', 'purple_dot');
    expect(resolveProfileRef(FILE, env(root, 'purple_dot', 'up-gzb'))).toBe(
      'purple_dot/aggregator-forms',
    );
  });

  it('returns null when no copy exists anywhere', () => {
    const root = rootWith();
    expect(resolveProfileRef(FILE, env(root, 'blue_dot'))).toBeNull();
  });
});

describe('resolveSchema', () => {
  it('returns a readable path alongside the ref', () => {
    const root = rootWith('', 'blue_dot');
    const resolved = resolveSchema(FILE, env(root, 'blue_dot'));
    expect(resolved?.path).toBe(path.join(root, 'blue_dot', 'schemas', 'aggregator', FILE));
    expect(resolved?.ref).toBe('blue_dot/aggregator-forms');
  });

  it('returns null for a file that does not exist', () => {
    const root = rootWith('', 'blue_dot');
    expect(resolveSchema('no-such.json', env(root, 'blue_dot'))).toBeNull();
  });
});
