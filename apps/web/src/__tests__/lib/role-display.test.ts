import { describe, it, expect } from 'vitest';
import { withRoleDisplayNames } from '@/lib/role-display';

describe('withRoleDisplayNames', () => {
  const roles = [
    { key: 'coordinator', name: 'Coordinator', extra: 1 },
    { key: 'pii_access', name: 'PII Access', extra: 2 },
  ];

  it('renames only the team-member base role and keeps every other field', () => {
    expect(withRoleDisplayNames(roles, 'Onboard Seekers & Providers')).toEqual([
      { key: 'coordinator', name: 'Onboard Seekers & Providers', extra: 1 },
      { key: 'pii_access', name: 'PII Access', extra: 2 },
    ]);
  });

  it('does not change the roles it is given', () => {
    withRoleDisplayNames(roles, 'X');
    expect(roles[0]?.name).toBe('Coordinator');
  });

  it('returns nothing for no roles', () => {
    expect(withRoleDisplayNames([], 'X')).toEqual([]);
  });
});
