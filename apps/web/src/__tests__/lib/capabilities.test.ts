import { describe, expect, it } from 'vitest';
import { can } from '@/lib/capabilities';

describe('can', () => {
  it('allows everything when access control is off', () => {
    expect(can(null, 'profiles.view_pii')).toBe(true);
    expect(can(undefined, 'org.manage')).toBe(true);
  });

  it('allows only listed capabilities otherwise', () => {
    expect(can(['profiles.view'], 'profiles.view')).toBe(true);
    expect(can(['profiles.view'], 'profiles.view_pii')).toBe(false);
    expect(can([], 'profiles.view')).toBe(false);
  });
});
