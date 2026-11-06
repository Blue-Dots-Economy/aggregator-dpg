import { describe, it, expect } from 'vitest';
import { toErrorSchema } from '@/app/[org]/[slug]/_lib/field-errors';

describe('toErrorSchema — merging', () => {
  it('keeps a parent message and a child message on the same branch', () => {
    expect(toErrorSchema({ 'address.city': 'bad city', address: 'bad address' })).toEqual({
      address: { __errors: ['bad address'], city: { __errors: ['bad city'] } },
    });
  });

  it('skips an empty path and keeps the rest', () => {
    expect(toErrorSchema({ '': 'x', name: 'required' })).toEqual({
      name: { __errors: ['required'] },
    });
  });

  it('returns undefined for null and for an object with only skipped paths', () => {
    expect(toErrorSchema(null)).toBeUndefined();
    expect(toErrorSchema({ '__proto__.x': 'y' })).toBeUndefined();
  });
});
