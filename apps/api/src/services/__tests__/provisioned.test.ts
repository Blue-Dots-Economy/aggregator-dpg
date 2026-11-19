import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aggregator-dpg/shared-primitives/errors';
import { PROVISIONED_PREFIX, isProvisioned, provisionedBy } from '../provisioned.js';

describe('provisioned marker', () => {
  it('prefixes the operator', () => {
    expect(PROVISIONED_PREFIX).toBe('provisioned:');
    expect(provisionedBy('ops-anil')).toBe('provisioned:ops-anil');
  });

  it.each(['', 'a b', 'a:b', 'a\tb'])('rejects operator %j', (operator) => {
    expect(() => provisionedBy(operator)).toThrow(ValidationError);
  });

  it('recognises provisioned accounts only', () => {
    expect(isProvisioned('provisioned:x')).toBe(true);
    expect(isProvisioned('self')).toBe(false);
    expect(isProvisioned('system')).toBe(false);
    expect(isProvisioned(null)).toBe(false);
    expect(isProvisioned(undefined)).toBe(false);
  });
});
