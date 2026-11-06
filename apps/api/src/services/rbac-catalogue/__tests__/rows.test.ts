/**
 * Unit tests for mapping stored role rows to role definitions (`@aggregator-dpg/api`).
 */
import { describe, expect, it, vi } from 'vitest';
import { roleDefinitionsFromRows, type RoleRow } from '../rows.js';

const row = (over: Partial<RoleRow> = {}): RoleRow => ({
  key: 'verifier',
  name: 'Verifier',
  description: 'Checks profiles',
  isBuiltin: false,
  accountType: 'coordinator',
  baseFor: null,
  assignableOrgTypes: ['aggregator'],
  assignedBy: 'org.manage',
  maxDays: 30,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe('roleDefinitionsFromRows', () => {
  it('maps each row with its permissions, sorted', () => {
    const warn = vi.fn();
    const roles = roleDefinitionsFromRows(
      [
        row(),
        row({
          key: 'member',
          isBuiltin: true,
          baseFor: 'org_member',
          assignedBy: null,
          maxDays: null,
        }),
      ],
      [
        { roleKey: 'verifier', permissionKey: 'profiles.view' },
        { roleKey: 'verifier', permissionKey: 'profiles.verify' },
      ],
      warn,
    );
    expect(roles).toEqual([
      {
        key: 'verifier',
        name: 'Verifier',
        description: 'Checks profiles',
        isBuiltin: false,
        accountType: 'coordinator',
        baseFor: null,
        assignableOrgTypes: ['aggregator'],
        assignedBy: 'org.manage',
        maxDays: 30,
        permissions: ['profiles.verify', 'profiles.view'],
      },
      {
        key: 'member',
        name: 'Verifier',
        description: 'Checks profiles',
        isBuiltin: true,
        accountType: 'coordinator',
        baseFor: 'org_member',
        assignableOrgTypes: ['aggregator'],
        assignedBy: null,
        maxDays: null,
        permissions: [],
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a stored permission the code does not know, and reports it', () => {
    const warn = vi.fn();
    const [role] = roleDefinitionsFromRows(
      [row()],
      [
        { roleKey: 'verifier', permissionKey: 'profiles.verify' },
        { roleKey: 'verifier', permissionKey: 'profiles.teleport' },
      ],
      warn,
    );
    expect(role?.permissions).toEqual(['profiles.verify']);
    expect(warn).toHaveBeenCalledWith({
      role: 'verifier',
      reason: 'unknown_permission',
      value: 'profiles.teleport',
    });
  });

  it('skips a role whose assigned_by permission the code does not know, and reports it', () => {
    const warn = vi.fn();
    const roles = roleDefinitionsFromRows([row({ assignedBy: 'org.rule' })], [], warn);
    expect(roles).toEqual([]);
    expect(warn).toHaveBeenCalledWith({
      role: 'verifier',
      reason: 'unknown_assigned_by',
      value: 'org.rule',
    });
  });

  it('skips a role whose base_for the code does not know, and reports it', () => {
    const warn = vi.fn();
    const roles = roleDefinitionsFromRows(
      [row({ baseFor: 'org_guest', assignedBy: null })],
      [],
      warn,
    );
    expect(roles).toEqual([]);
    expect(warn).toHaveBeenCalledWith({
      role: 'verifier',
      reason: 'unknown_base_for',
      value: 'org_guest',
    });
  });

  it('returns no roles for no rows', () => {
    expect(roleDefinitionsFromRows([], [], vi.fn())).toEqual([]);
  });
});
