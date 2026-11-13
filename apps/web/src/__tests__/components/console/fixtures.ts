/**
 * Valid console API bodies for the console component tests (web app).
 *
 * Each builder fills every field its schema requires and parses the result,
 * so a fixture that drifts from the shared schema fails at the call site.
 */

import {
  DecisionResponseSchema,
  OrgDecisionResponseSchema,
  OrgSchema,
  OwnerAccessResponseSchema,
  RoleAssignmentSchema,
  RoleSchema,
  UserInviteResponseSchema,
  UserSchema,
  type DecisionResponse,
  type Org,
  type OrgDecisionResponse,
  type OwnerAccessResponse,
  type Role,
  type RoleAssignment,
  type User,
  type UserInviteResponse,
} from '@aggregator-dpg/shared-primitives/user-org';

const CREATED_AT = '2026-01-01T00:00:00Z';

/**
 * An active top-level organisation.
 *
 * @param overrides - Fields to change.
 */
export function org(overrides: Partial<Org> = {}): Org {
  return OrgSchema.parse({
    id: '00000000-0000-4000-8000-0000000000a1',
    slug: 'acme',
    name: 'Acme Org',
    org_type: 'aggregator',
    status: 'active',
    is_default: false,
    locations: [],
    legal_name: null,
    known_as: 'aggregator',
    known_as_name: 'Aggregator',
    depth: 1,
    parent_id: null,
    parent_name: null,
    description: null,
    profile: {},
    profile_ref: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  });
}

/**
 * A pending coordinator who serves every domain.
 *
 * @param overrides - Fields to change.
 */
export function user(overrides: Partial<User> = {}): User {
  return UserSchema.parse({
    id: '00000000-0000-4000-8000-0000000000c1',
    user_type: 'coordinator',
    status: 'pending',
    name: 'Coordinator One',
    contact: { name: 'C1', email: 'c1@x.org', phone: null },
    serves: [],
    org_id: null,
    invited: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    rejected_at: null,
    ...overrides,
  });
}

/**
 * The reply to a coordinator decision.
 *
 * @param overrides - Fields to change.
 */
export function decision(overrides: Partial<DecisionResponse> = {}): DecisionResponse {
  return DecisionResponseSchema.parse({
    id: '00000000-0000-4000-8000-0000000000c1',
    status: 'active',
    notified: true,
    ...overrides,
  });
}

/**
 * The reply to an organisation decision.
 *
 * @param overrides - Fields to change.
 */
export function orgDecision(overrides: Partial<OrgDecisionResponse> = {}): OrgDecisionResponse {
  return OrgDecisionResponseSchema.parse({
    id: '00000000-0000-4000-8000-0000000000a1',
    status: 'active',
    notified: true,
    owner_access: 'granted',
    ...overrides,
  });
}

/**
 * The reply to an owner access repair.
 *
 * @param overrides - Fields to change.
 */
export function ownerAccess(overrides: Partial<OwnerAccessResponse> = {}): OwnerAccessResponse {
  return OwnerAccessResponseSchema.parse({
    id: '00000000-0000-4000-8000-0000000000a1',
    status: 'granted',
    enable: 'ok',
    role: 'ok',
    group: 'ok',
    ...overrides,
  });
}

/**
 * A custom coordinator role.
 *
 * @param overrides - Fields to change.
 */
export function role(overrides: Partial<Role> = {}): Role {
  return RoleSchema.parse({
    key: 'verifier',
    name: 'Verifier',
    description: '',
    is_builtin: false,
    account_type: 'coordinator',
    base_for: null,
    assignable_org_types: ['aggregator'],
    assigned_by: 'roles.assign',
    max_days: null,
    permissions: [],
    ...overrides,
  });
}

/**
 * A live additional-role assignment with no end date.
 *
 * @param overrides - Fields to change.
 */
export function roleAssignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return RoleAssignmentSchema.parse({
    id: '00000000-0000-4000-8000-0000000000d1',
    role_key: 'verifier',
    org_id: '00000000-0000-4000-8000-0000000000a1',
    granted_by: null,
    granted_at: CREATED_AT,
    expires_at: null,
    revoked_at: null,
    live: true,
    ...overrides,
  });
}

/**
 * The reply to a coordinator invite with nothing sent.
 *
 * @param overrides - Fields to change.
 */
export function inviteResult(overrides: Partial<UserInviteResponse> = {}): UserInviteResponse {
  return UserInviteResponseSchema.parse({
    sent: 0,
    resent: 0,
    invalid: [],
    existing: [],
    ...overrides,
  });
}
