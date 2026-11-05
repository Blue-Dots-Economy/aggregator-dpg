import { describe, expect, it } from 'vitest';
import { errorField, pgConstraint, pgErrorCode } from '../pg-error.js';

/** A driver error wrapped the way Drizzle wraps it: SQLSTATE on `.cause`. */
function wrapped(cause: unknown): Error {
  return new Error('Failed query: insert into users ...', { cause });
}

describe('errorField', () => {
  it('reads a string field of a driver error', () => {
    const err = Object.assign(new Error('boom'), { code: '23505', constraint: 'users_pk' });
    expect(errorField(err, 'code')).toBe('23505');
    expect(errorField(err, 'constraint')).toBe('users_pk');
    expect(errorField(err, 'message')).toBe('boom');
  });

  it('reads the inherited name of an Error', () => {
    expect(errorField(new TypeError('x'), 'name')).toBe('TypeError');
  });

  it('answers undefined for a missing or non-string field', () => {
    expect(errorField(new Error('x'), 'table')).toBeUndefined();
    expect(errorField({ code: 42 }, 'code')).toBeUndefined();
  });

  it('answers undefined for a value that is not an object', () => {
    expect(errorField('boom', 'code')).toBeUndefined();
    expect(errorField(null, 'code')).toBeUndefined();
    expect(errorField(undefined, 'name')).toBeUndefined();
  });

  it('does not read the cause chain', () => {
    expect(errorField(wrapped({ code: '23505' }), 'code')).toBeUndefined();
  });
});

describe('pgErrorCode and pgConstraint', () => {
  it('read the fields of an unwrapped driver error', () => {
    const err = { code: '23514', constraint: 'users_role_shape_chk' };
    expect(pgErrorCode(err)).toBe('23514');
    expect(pgConstraint(err)).toBe('users_role_shape_chk');
  });

  it('find the fields on the cause of a wrapped error', () => {
    const err = wrapped({ code: '23505', constraint: 'contact_email_unique' });
    expect(pgErrorCode(err)).toBe('23505');
    expect(pgConstraint(err)).toBe('contact_email_unique');
  });

  it('stop after MAX_CAUSE_DEPTH (5) levels', () => {
    let err: unknown = { code: '23505' };
    for (let i = 0; i < 5; i++) err = wrapped(err);
    expect(pgErrorCode(err)).toBeUndefined();
  });

  it('stop on a cause chain that loops back on itself', () => {
    const a: { cause?: unknown } = {};
    const b = { cause: a };
    a.cause = b;
    expect(pgErrorCode(a)).toBeUndefined();
    expect(pgConstraint(b)).toBeUndefined();
  });

  it('answer undefined for non-errors and non-string codes', () => {
    expect(pgErrorCode(undefined)).toBeUndefined();
    expect(pgErrorCode('23505')).toBeUndefined();
    expect(pgErrorCode({ code: 23505 })).toBeUndefined();
  });
});
