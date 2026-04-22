import { describe, it, expect, vi } from 'vitest';
import { ok, err, match, map, flatMap, mapErr, unwrap, getOrElse } from '../result/index.js';

describe('ok / err constructors', () => {
  it('ok creates success result', () => {
    const r = ok(42);
    expect(r.success).toBe(true);
    if (r.success) expect(r.value).toBe(42);
  });

  it('err creates failure result', () => {
    const r = err('oops');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe('oops');
  });
});

describe('match', () => {
  it('calls onOk for success', () => {
    const r = ok(10);
    const result = match(r, { onOk: (v) => v * 2, onErr: () => -1 });
    expect(result).toBe(20);
  });

  it('calls onErr for failure', () => {
    const r = err('fail');
    const result = match(r, { onOk: () => 'ok', onErr: (e) => e.toUpperCase() });
    expect(result).toBe('FAIL');
  });
});

describe('map', () => {
  it('transforms success value', () => {
    const r = map(ok(5), (v) => v + 1);
    expect(r).toEqual(ok(6));
  });

  it('passes error through unchanged', () => {
    const r = map(err('e'), (v: number) => v + 1);
    expect(r).toEqual(err('e'));
  });
});

describe('flatMap', () => {
  it('chains ok results', () => {
    const r = flatMap(ok(5), (v) => ok(v * 2));
    expect(r).toEqual(ok(10));
  });

  it('returns inner err from ok input', () => {
    const r = flatMap(ok(5), () => err('downstream'));
    expect(r).toEqual(err('downstream'));
  });

  it('passes original error through without calling fn', () => {
    const fn = vi.fn();
    const r = flatMap(err('original'), fn);
    expect(r).toEqual(err('original'));
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('mapErr', () => {
  it('transforms error value', () => {
    const r = mapErr(err('e'), (e) => e.toUpperCase());
    expect(r).toEqual(err('E'));
  });

  it('passes success through unchanged', () => {
    const r = mapErr(ok(1), (e: string) => e.toUpperCase());
    expect(r).toEqual(ok(1));
  });
});

describe('unwrap', () => {
  it('returns value for ok', () => {
    expect(unwrap(ok('val'))).toBe('val');
  });

  it('throws error for err', () => {
    expect(() => unwrap(err(new Error('boom')))).toThrow('boom');
  });
});

describe('getOrElse', () => {
  it('returns value for ok', () => {
    expect(getOrElse(ok(7), 0)).toBe(7);
  });

  it('returns fallback for err', () => {
    expect(getOrElse(err('e'), 99)).toBe(99);
  });
});
