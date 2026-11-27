/**
 * Unit tests for `lib/request-errors`: one message kind per failed request,
 * and the API's code and field map read off an `HttpError`.
 */
import { describe, it, expect } from 'vitest';
import { requestErrorCode, requestErrorFields, requestErrorKind } from '@/lib/request-errors';
import { HttpError } from '@/services/http';

describe('requestErrorKind', () => {
  it.each([
    [0, 'network'],
    [400, 'invalid'],
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'too_large'],
    [422, 'invalid'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [418, 'generic'],
  ] as const)('maps status %i to %s', (status, kind) => {
    expect(requestErrorKind(status)).toBe(kind);
    expect(requestErrorKind(new HttpError(status))).toBe(kind);
  });

  it('reads a TypeError as a network failure and anything else as generic', () => {
    expect(requestErrorKind(new TypeError('Failed to fetch'))).toBe('network');
    expect(requestErrorKind(new Error('x'))).toBe('generic');
    expect(requestErrorKind(undefined)).toBe('generic');
  });
});

describe('requestErrorCode / requestErrorFields', () => {
  it("returns the API's code and fields from an HttpError only", () => {
    const err = new HttpError(400, { code: 'SCHEMA_VALIDATION', fields: { phone: 'x' } });
    expect(requestErrorCode(err)).toBe('SCHEMA_VALIDATION');
    expect(requestErrorFields(err)).toEqual({ phone: 'x' });
    expect(requestErrorCode(new Error('x'))).toBeUndefined();
    expect(requestErrorFields(new Error('x'))).toBeUndefined();
  });
});
