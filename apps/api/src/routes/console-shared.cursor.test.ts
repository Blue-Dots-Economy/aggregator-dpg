/**
 * Unit tests for the console page cursors (`@aggregator-dpg/api`).
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors/http-error.js';
import {
  decodeOrgCursor,
  decodeUserCursor,
  encodeOrgCursor,
  encodeUserCursor,
} from './console-shared.js';

/** A base64url cursor from an arbitrary JSON payload. */
const cursorOf = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

/** The error code a decode throws, or `null` when it returns. */
function codeOf(decode: () => unknown): string | null {
  try {
    decode();
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.code : 'not-http-error';
  }
}

const malformed: Array<[string, string]> = [
  ['not base64 JSON', 'not-a-cursor'],
  ['JSON null', cursorOf(null)],
  ['a JSON string', cursorOf('abc')],
  ['a JSON array', cursorOf(['x', 'y'])],
];

describe('decodeUserCursor', () => {
  it('round-trips an encoded cursor', () => {
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    expect(decodeUserCursor(encodeUserCursor({ createdAt, id: 'u-1' }))).toEqual({
      createdAt,
      id: 'u-1',
    });
  });

  it('ignores extra keys', () => {
    const decoded = decodeUserCursor(cursorOf({ c: '2026-01-02T00:00:00.000Z', i: 'u-1', x: 1 }));
    expect(decoded.id).toBe('u-1');
  });

  it.each(malformed)('refuses %s', (_label, cursor) => {
    expect(codeOf(() => decodeUserCursor(cursor))).toBe('SCHEMA_VALIDATION');
  });

  it('refuses a cursor with a missing or non-string field', () => {
    expect(codeOf(() => decodeUserCursor(cursorOf({ c: '2026-01-02' })))).toBe('SCHEMA_VALIDATION');
    expect(codeOf(() => decodeUserCursor(cursorOf({ c: 5, i: 'u-1' })))).toBe('SCHEMA_VALIDATION');
  });

  it('refuses a created-at that is not a date', () => {
    expect(codeOf(() => decodeUserCursor(cursorOf({ c: 'nope', i: 'u-1' })))).toBe(
      'SCHEMA_VALIDATION',
    );
  });
});

describe('decodeOrgCursor', () => {
  it('round-trips an encoded cursor', () => {
    expect(decodeOrgCursor(encodeOrgCursor({ name: 'Asha Org', id: 'o-1' }))).toEqual({
      name: 'Asha Org',
      id: 'o-1',
    });
  });

  it.each(malformed)('refuses %s', (_label, cursor) => {
    expect(codeOf(() => decodeOrgCursor(cursor))).toBe('SCHEMA_VALIDATION');
  });

  it('refuses a cursor with a missing or non-string field', () => {
    expect(codeOf(() => decodeOrgCursor(cursorOf({ n: 'Asha' })))).toBe('SCHEMA_VALIDATION');
    expect(codeOf(() => decodeOrgCursor(cursorOf({ n: 'Asha', i: 7 })))).toBe('SCHEMA_VALIDATION');
  });
});
