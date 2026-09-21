/**
 * `loadPublishedForm` — reading the published bundle off the mounted tree.
 *
 * Exercised against a real temp directory rather than a mocked `fs`: the thing
 * worth testing is that the resolver finds the file the initContainer actually
 * mounts, and a mock of `readFile` would assert nothing about paths.
 *
 * Every failure mode must return `null` rather than throw. The caller turns
 * that into its own user-facing state; an exception here is an unhandled
 * render error on the public registration page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPublishedForm, _resetFormsBundle } from '@/lib/aggregator-forms.server';

const BUNDLE = {
  forms: {
    'coordinator-registration': { type: 'object', title: 'Coordinator' },
    'org-registration': { type: 'object', title: 'Organisation' },
    profile: { type: 'object', title: 'Profile' },
  },
};

const roots: string[] = [];
const origRoot = process.env.CONFIG_ROOT;
const origNetwork = process.env.AGGREGATOR_NETWORK;
const origBrand = process.env.AGGREGATOR_BRAND;

/** Writes `body` as the bundle at `scope` in a fresh temp root, and mounts it. */
function mount(body: unknown, scope = ''): string {
  const root = mkdtempSync(path.join(tmpdir(), 'web-forms-'));
  roots.push(root);
  if (body !== undefined) {
    const dir = path.join(root, scope, 'schemas', 'aggregator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'aggregator-forms.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8',
    );
  }
  process.env.CONFIG_ROOT = root;
  return root;
}

beforeEach(() => {
  _resetFormsBundle();
  delete process.env.AGGREGATOR_BRAND;
  process.env.AGGREGATOR_NETWORK = 'blue_dot';
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore('CONFIG_ROOT', origRoot);
  restore('AGGREGATOR_NETWORK', origNetwork);
  restore('AGGREGATOR_BRAND', origBrand);
});

describe('loadPublishedForm', () => {
  it('returns the requested form from the shared default', async () => {
    mount(BUNDLE);
    await expect(loadPublishedForm('coordinator-registration')).resolves.toEqual({
      type: 'object',
      title: 'Coordinator',
    });
  });

  it('prefers a brand bundle over its network and the shared default', async () => {
    // The override mechanism is now the path, not a per-scope URL, so this is
    // the test that brand deployments still get their own form.
    const root = mount(BUNDLE);
    process.env.AGGREGATOR_BRAND = 'up-gzb';
    const dir = path.join(root, 'blue_dot', 'up-gzb', 'schemas', 'aggregator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'aggregator-forms.json'),
      JSON.stringify({ forms: { profile: { type: 'object', title: 'UP-GZB profile' } } }),
      'utf8',
    );

    await expect(loadPublishedForm('profile')).resolves.toEqual({
      type: 'object',
      title: 'UP-GZB profile',
    });
  });

  it('returns null when the bundle omits that form', async () => {
    // A bundle that does not serve this form is a normal state for an instance
    // without the org tab, not an error.
    mount({ forms: { profile: {} } });
    await expect(loadPublishedForm('org-registration')).resolves.toBeNull();
  });

  it('returns null when the mount carries no bundle', async () => {
    mount(undefined);
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('returns null when the bundle is not JSON', async () => {
    // What a GitHub 404 page looks like if one is ever committed by mistake.
    mount('<!doctype html>');
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('returns null when the bundle has no `forms` object', async () => {
    mount({ nope: true });
    await expect(loadPublishedForm('profile')).resolves.toBeNull();
  });

  it('does not cache a failure — a later read can still succeed', async () => {
    // An instance that rendered before its mount was ready must recover
    // without a restart.
    mount(undefined);
    await expect(loadPublishedForm('profile')).resolves.toBeNull();

    mount(BUNDLE);
    await expect(loadPublishedForm('profile')).resolves.toEqual({
      type: 'object',
      title: 'Profile',
    });
  });

  it('parses the bundle once and serves later forms from cache', async () => {
    const root = mount(BUNDLE);
    await loadPublishedForm('profile');
    // Remove the file: a second read that still succeeds proves it was cached
    // rather than re-read on every render.
    rmSync(path.join(root, 'schemas'), { recursive: true, force: true });
    await expect(loadPublishedForm('coordinator-registration')).resolves.toMatchObject({
      title: 'Coordinator',
    });
  });
});
