/**
 * Unit tests for the RBAC edge test hooks (`@aggregator-dpg/api`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_EDGE_FETCH_KEY,
  edgeFetchRecorder,
  installedEdgeFetchRecorder,
} from '../edge-test-hook.js';

const saved: unknown = Reflect.get(globalThis, TEST_EDGE_FETCH_KEY);

afterEach(() => {
  Reflect.set(globalThis, TEST_EDGE_FETCH_KEY, saved);
});

describe('edgeFetchRecorder', () => {
  it('answers 204 and keeps each parsed body', async () => {
    const rec = edgeFetchRecorder();
    const res = await rec.fetch('http://opa/v1/data/catalogue', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'enforce' }),
    });
    expect(res.status).toBe(204);
    await rec.fetch('http://opa/v1/data/catalogue');
    expect(rec.bodies).toEqual([{ mode: 'enforce' }, null]);
  });
});

describe('installedEdgeFetchRecorder', () => {
  it('returns the recorder the setup installed', () => {
    const rec = edgeFetchRecorder();
    Reflect.set(globalThis, TEST_EDGE_FETCH_KEY, rec);
    expect(installedEdgeFetchRecorder()).toBe(rec);
  });

  it('returns undefined when nothing, or something else, is installed', () => {
    Reflect.set(globalThis, TEST_EDGE_FETCH_KEY, undefined);
    expect(installedEdgeFetchRecorder()).toBeUndefined();
    Reflect.set(globalThis, TEST_EDGE_FETCH_KEY, { fetch: 'nope', bodies: [] });
    expect(installedEdgeFetchRecorder()).toBeUndefined();
  });
});
