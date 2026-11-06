/**
 * Maps stored role rows to role definitions (`@aggregator-dpg/api`).
 *
 * The `permission` table may hold a key the code no longer lists. A stored
 * value the code does not know never stops the catalogue from loading:
 * an unknown permission is dropped from its role, and a role whose
 * `assigned_by` or `base_for` is unknown is left out. Both are reported, and
 * both grant less, never more.
 */

import {
  BaseForSchema,
  CapabilitySchema,
  type Capability,
  type RoleDefinition,
} from '@aggregator-dpg/rbac/interface';
import { compareCodeUnits } from '@aggregator-dpg/rbac';
import type { role, rolePermission } from '../../db/schema.js';

/** A `role` row. */
export type RoleRow = typeof role.$inferSelect;

/** A `role_permission` row. */
export type RolePermissionRow = typeof rolePermission.$inferSelect;

/** A stored value the code does not know, reported by {@link roleDefinitionsFromRows}. */
export interface UnknownStoredValue {
  role: string;
  reason: 'unknown_permission' | 'unknown_assigned_by' | 'unknown_base_for';
  value: string;
}

/**
 * Builds the role definitions from the role and role-permission rows.
 *
 * @param roles - The `role` rows.
 * @param links - The `role_permission` rows.
 * @param report - Called once for each stored value the code does not know.
 * @returns One definition per usable role, its permissions sorted.
 */
export function roleDefinitionsFromRows(
  roles: readonly RoleRow[],
  links: readonly RolePermissionRow[],
  report: (unknown: UnknownStoredValue) => void,
): RoleDefinition[] {
  const permsOf = new Map<string, Capability[]>();
  for (const l of links) {
    const permission = CapabilitySchema.safeParse(l.permissionKey);
    if (!permission.success) {
      report({ role: l.roleKey, reason: 'unknown_permission', value: l.permissionKey });
      continue;
    }
    permsOf.set(l.roleKey, [...(permsOf.get(l.roleKey) ?? []), permission.data]);
  }
  const out: RoleDefinition[] = [];
  for (const r of roles) {
    const baseFor = BaseForSchema.nullable().safeParse(r.baseFor);
    if (!baseFor.success) {
      report({ role: r.key, reason: 'unknown_base_for', value: String(r.baseFor) });
      continue;
    }
    const assignedBy = CapabilitySchema.nullable().safeParse(r.assignedBy);
    if (!assignedBy.success) {
      report({ role: r.key, reason: 'unknown_assigned_by', value: String(r.assignedBy) });
      continue;
    }
    out.push({
      key: r.key,
      name: r.name,
      description: r.description,
      isBuiltin: r.isBuiltin,
      accountType: r.accountType,
      baseFor: baseFor.data,
      assignableOrgTypes: r.assignableOrgTypes,
      assignedBy: assignedBy.data,
      maxDays: r.maxDays,
      permissions: (permsOf.get(r.key) ?? []).sort(compareCodeUnits),
    });
  }
  return out;
}
