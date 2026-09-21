/**
 * Unit tests for the API-side published-form accessor.
 *
 * Reads a real temp tree rather than a mocked `fs`: what matters is that it
 * finds the file the initContainer mounts, and that the `profile_ref` it
 * derives names the bundle that actually answered — a ref claiming a brand the
 * payload did not come from is the failure this column exists to catch.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getPublishedForm, publishedFormRef, _resetFormsBundle } from './aggregator-forms.js';

const BUNDLE = {
  forms: {
    'coordinator-registration': { type: 'object', title: 'Coordinator' },
    'org-registration': { type: 'object', title: 'Organisation' },
    profile: { type: 'object', title: 'Profile' },
  },
};

const roots: string[] = [];

/** Builds a temp root, optionally writing `body` as the bundle at `scope`. */
function root(body?: unknown, scope = ''): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'api-forms-'));
  roots.push(dir);
  if (body !== undefined) {
    const target = path.join(dir, scope, 'schemas', 'aggregator');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, 'aggregator-forms.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8',
    );
  }
  return dir;
}

const env = (CONFIG_ROOT: string, AGGREGATOR_NETWORK = 'blue_dot', AGGREGATOR_BRAND?: string) => ({
  CONFIG_ROOT,
  AGGREGATOR_NETWORK,
  ...(AGGREGATOR_BRAND ? { AGGREGATOR_BRAND } : {}),
});

beforeEach(() => _resetFormsBundle());
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('getPublishedForm', () => {
  it('returns the form and a ref naming the shared default', () => {
    const r = root(BUNDLE);
    const form = getPublishedForm('coordinator-registration', env(r));
    expect(form?.schema).toEqual({ type: 'object', title: 'Coordinator' });
    expect(form?.ref).toBe('coordinator-registration');
  });

  it('names the network scope in the ref when the network ships a bundle', () => {
    const r = root(BUNDLE, 'blue_dot');
    expect(getPublishedForm('profile', env(r))?.ref).toBe('blue_dot/profile');
  });

  it('prefers the brand bundle and says so in the ref', () => {
    const r = root(BUNDLE, 'blue_dot');
    const dir = path.join(r, 'blue_dot', 'up-gzb', 'schemas', 'aggregator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'aggregator-forms.json'),
      JSON.stringify({ forms: { profile: { type: 'object', title: 'UP-GZB' } } }),
      'utf8',
    );

    const form = getPublishedForm('profile', env(r, 'blue_dot', 'up-gzb'));
    expect(form?.schema).toMatchObject({ title: 'UP-GZB' });
    expect(form?.ref).toBe('blue_dot/up-gzb/profile');
  });

  it('does NOT claim a brand whose bundle is absent', () => {
    const r = root(BUNDLE, 'blue_dot');
    expect(getPublishedForm('profile', env(r, 'blue_dot', 'up-gzb'))?.ref).toBe('blue_dot/profile');
  });

  it('returns null when the bundle omits that form', () => {
    expect(getPublishedForm('org-registration', env(root({ forms: { profile: {} } })))).toBeNull();
  });

  it('returns null when the mount carries no bundle', () => {
    expect(getPublishedForm('profile', env(root()))).toBeNull();
  });

  it('returns null rather than throwing on a non-JSON bundle', () => {
    // A deployment fault the route turns into a 503, not an exception to
    // unwind a request through.
    expect(getPublishedForm('profile', env(root('<!doctype html>')))).toBeNull();
  });

  it('returns null when the bundle has no `forms` object', () => {
    expect(getPublishedForm('profile', env(root({ nope: true })))).toBeNull();
  });

  it('does not cache a failure — a later call can still succeed', () => {
    expect(getPublishedForm('profile', env(root()))).toBeNull();
    expect(getPublishedForm('profile', env(root(BUNDLE)))).not.toBeNull();
  });

  it('parses once and serves later forms from cache', () => {
    const r = root(BUNDLE);
    getPublishedForm('profile', env(r));
    rmSync(path.join(r, 'schemas'), { recursive: true, force: true });
    expect(getPublishedForm('coordinator-registration', env(r))?.schema).toMatchObject({
      title: 'Coordinator',
    });
  });
});

describe('publishedFormRef', () => {
  it('returns the ref for a present form', () => {
    expect(publishedFormRef('profile', env(root(BUNDLE, 'blue_dot')))).toBe('blue_dot/profile');
  });

  it('returns null when the form is unavailable', () => {
    // Recording a ref for a form that did not answer is worse than recording
    // that the variant is unknown.
    expect(publishedFormRef('profile', env(root()))).toBeNull();
  });
});
