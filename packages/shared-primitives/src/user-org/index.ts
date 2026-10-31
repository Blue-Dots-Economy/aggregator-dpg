/**
 * Wire schemas of the console APIs `/v1/user/*` and `/v1/org/*`. Shared by the
 * API (zod → OpenAPI) and the web BFF / console.
 *
 * Wire style as the rest of the API: snake_case keys, no envelope, `.strict()`
 * request bodies. Paging is keyset with an opaque `cursor` string.
 *
 * @module @aggregator-dpg/shared-primitives/user-org
 */

import { z } from 'zod';

import { BecknLocationSchema } from '../beckn/index.js';

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** Registration / org lifecycle status. */
export const UserOrgStatusSchema = z.enum(['pending', 'active', 'inactive', 'retired']);
export type UserOrgStatus = z.infer<typeof UserOrgStatusSchema>;

/** Organisation type. */
export const OrgTypeSchema = z.enum(['network_facilitator', 'aggregator']);
export type OrgType = z.infer<typeof OrgTypeSchema>;

/** A person's contact as the console shows it, unmasked. */
export const PersonContactSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
});
export type PersonContact = z.infer<typeof PersonContactSchema>;

/** Opaque keyset cursor; the server decodes and validates it. */
export const CursorSchema = z.string().min(1).max(512);

/** Page size of a search, 1..100. */
export const PageLimitSchema = z.number().int().min(1).max(100);

/** A free-text decision reason, mailed to the applicant; never logged. */
export const DecisionReasonSchema = z.string().trim().min(1).max(500);

// ─── Users ──────────────────────────────────────────────────────────────────

/** A coordinator as the console shows it. */
export const UserSchema = z.object({
  id: z.string(),
  user_type: z.literal('coordinator'),
  status: UserOrgStatusSchema,
  /** The coordinator's own organisation name as registered (its Signals org). */
  name: z.string(),
  contact: PersonContactSchema,
  /** Network domain ids served; `[]` = every domain. */
  serves: z.array(z.string()),
  org_id: z.string().nullable(),
  /** Registered through an invite. */
  invited: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  rejected_at: z.string().nullable(),
  /**
   * Keys of the additional roles the coordinator holds now in its
   * organisation (RBAC), sorted; on search results only. `null` when access
   * control is off.
   */
  roles: z.array(z.string()).nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

/** One org of the signed-in actor. */
export const MeOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  org_type: OrgTypeSchema,
  role: z.enum(['owner', 'member']),
  is_default: z.boolean(),
  /** The caller's permissions in this organisation (RBAC); `null` when access control is off. */
  capabilities: z.array(z.string()).nullable().optional(),
});
export type MeOrg = z.infer<typeof MeOrgSchema>;

/** `GET /v1/user/read/me`. */
export const MeResponseSchema = z.object({
  kind: z.enum(['admin', 'coordinator']),
  user: z.object({ id: z.string(), contact: PersonContactSchema }),
  orgs: z.array(MeOrgSchema),
  is_network_admin: z.boolean(),
  /**
   * The capabilities the caller holds (RBAC), for hiding what they cannot use.
   * `null` when access control is off for the instance: show everything.
   * The API decision, not this list, is the control.
   */
  capabilities: z.array(z.string()).nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `POST /v1/user/search`. */
export const UserSearchRequestSchema = z
  .object({
    filter: z
      .object({
        org_id: z.string().uuid().optional(),
        status: UserOrgStatusSchema.optional(),
        serves: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema.optional(),
  })
  .strict();
export type UserSearchRequest = z.infer<typeof UserSearchRequestSchema>;

export const UserSearchResponseSchema = z.object({
  users: z.array(UserSchema),
  next_cursor: z.string().nullable(),
});
export type UserSearchResponse = z.infer<typeof UserSearchResponseSchema>;

/** `POST /v1/user/create`: invite coordinators into an org. */
export const UserInviteRequestSchema = z
  .object({
    org_id: z.string().uuid(),
    recipients: z
      .array(
        z
          .object({ email: z.string().min(3).max(320), name: z.string().max(200).optional() })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type UserInviteRequest = z.infer<typeof UserInviteRequestSchema>;

export const UserInviteResponseSchema = z.object({
  sent: z.number().int(),
  resent: z.number().int(),
  invalid: z.array(z.object({ email: z.string(), reason: z.string() })),
  /** Addresses already coordinators of this org (nothing mailed). */
  existing: z.array(z.object({ email: z.string(), status: z.string() })),
});
export type UserInviteResponse = z.infer<typeof UserInviteResponseSchema>;

/** `POST /v1/user/decision/:id` and `POST /v1/org/decision/:id`. */
export const DecisionRequestSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: DecisionReasonSchema.optional(),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DecisionResponseSchema = z.object({
  id: z.string(),
  status: UserOrgStatusSchema,
  /** The applicant / owner was emailed. */
  notified: z.boolean(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** `PATCH /v1/user/metadata/update/:id`. */
export const UserMetadataUpdateRequestSchema = z
  .object({
    /** Network domain ids; `[]` = every domain. */
    serves: z.array(z.string().min(1)).max(50),
  })
  .strict();
export type UserMetadataUpdateRequest = z.infer<typeof UserMetadataUpdateRequestSchema>;

// ─── Organisations ──────────────────────────────────────────────────────────

/** An organisation as the console shows it. */
export const OrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  org_type: OrgTypeSchema,
  status: UserOrgStatusSchema,
  is_default: z.boolean(),
  locations: z.array(BecknLocationSchema),
  legal_name: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * Values of the deployment's org-registration schema fields (website, GST
   * number, domains, …), keyed by field name.
   */
  profile: z.record(z.string(), z.unknown()),
  /** The schema file that produced `profile`, e.g. `blue_dot/up-gzb/org-registration.v1`. */
  profile_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Org = z.infer<typeof OrgSchema>;

/** `GET /v1/org/read/:id`. */
export const OrgReadResponseSchema = z.object({
  org: OrgSchema,
  owner: z.object({ id: z.string(), contact: PersonContactSchema }),
  coordinator_count: z.number().int(),
  pending_count: z.number().int(),
});
export type OrgReadResponse = z.infer<typeof OrgReadResponseSchema>;

/** `POST /v1/org/search`. */
export const OrgSearchRequestSchema = z
  .object({
    filter: z
      .object({
        status: UserOrgStatusSchema.optional(),
        name_prefix: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .default({}),
    cursor: CursorSchema.optional(),
    limit: PageLimitSchema.optional(),
  })
  .strict();
export type OrgSearchRequest = z.infer<typeof OrgSearchRequestSchema>;

export const OrgSearchResponseSchema = z.object({
  orgs: z.array(
    OrgSchema.extend({
      coordinator_count: z.number().int(),
      pending_count: z.number().int(),
    }),
  ),
  next_cursor: z.string().nullable(),
});
export type OrgSearchResponse = z.infer<typeof OrgSearchResponseSchema>;

/**
 * `PATCH /v1/org/metadata/update/:id`, the org owner's only.
 *
 * `profile` holds schema fields to change: each value replaces the stored one,
 * `null` removes it. The API checks them against the deployment's
 * org-registration schema; only fields marked `x-updatable` are accepted.
 */
export const OrgMetadataUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    locations: z.array(BecknLocationSchema).max(25).optional(),
    legal_name: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    profile: z
      .record(z.string(), z.unknown())
      .refine((p) => Object.keys(p).length > 0, { message: 'profile must name a field' })
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field is required' });
export type OrgMetadataUpdateRequest = z.infer<typeof OrgMetadataUpdateRequestSchema>;

/** `POST /v1/org/decision/:id` response: adds what owner access achieved. */
export const OrgDecisionResponseSchema = DecisionResponseSchema.extend({
  owner_access: z.enum(['granted', 'partial', 'no_login', 'none']),
});
export type OrgDecisionResponse = z.infer<typeof OrgDecisionResponseSchema>;

/** `POST /v1/org/access/repair/:id` response. */
export const OwnerAccessResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['granted', 'partial', 'no_login']),
  enable: z.enum(['ok', 'failed', 'skipped']),
  role: z.enum(['ok', 'failed', 'skipped']),
  group: z.enum(['ok', 'failed', 'skipped']),
});
export type OwnerAccessResponse = z.infer<typeof OwnerAccessResponseSchema>;

// ─── RBAC roles ────────────────────────────────────────────────────────────

/** A role on the wire: a named set of permissions and the rules for holding it. */
export const RoleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  is_builtin: z.boolean(),
  account_type: z.enum(['admin', 'coordinator']),
  /** Set for a base role (follows membership); null for an additional role. */
  base_for: z.enum(['org_member', 'org_owner', 'root_owner']).nullable(),
  assignable_org_types: z.array(OrgTypeSchema),
  /** The permission an assigner needs; null for a base role. */
  assigned_by: z.string().nullable(),
  max_days: z.number().int().positive().nullable(),
  permissions: z.array(z.string()),
});
export type Role = z.infer<typeof RoleSchema>;

/** One permission of the catalogue on the wire. */
export const PermissionSchema = z.object({
  key: z.string(),
  resource: z.string(),
  action: z.string(),
  description: z.string(),
  sensitive: z.boolean(),
  /**
   * Whether any route checks this permission. The console marks permissions
   * that nothing enforces yet.
   */
  enforced: z.boolean(),
});
export type Permission = z.infer<typeof PermissionSchema>;

/** `GET /v1/roles`: every role, and the permissions a role can be composed from. */
export const RolesResponseSchema = z.object({
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
});
export type RolesResponse = z.infer<typeof RolesResponseSchema>;

/**
 * How a role is given: by membership (a base role, and which membership), or
 * assigned by holders of a named permission (an additional role).
 */
export const RoleGrantSchema = z.discriminatedUnion('via', [
  z.object({
    via: z.literal('membership'),
    membership: z.enum(['org_member', 'org_owner', 'root_owner']),
  }),
  z.object({ via: z.literal('assignment'), assigned_by: z.string() }),
]);
export type RoleGrant = z.infer<typeof RoleGrantSchema>;

/** One row of the network admin's read-only roles table (#871). */
export const CatalogueRoleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  is_builtin: z.boolean(),
  /** Who holds it: organisation owners (admin accounts) or coordinators. */
  held_by: z.enum(['org_owners', 'coordinators']),
  /** Organisation types it is held in. */
  held_in: z.array(OrgTypeSchema),
  granted: RoleGrantSchema,
  /** Longest validity of an assignment, in days; null = none applies. */
  max_days: z.number().int().positive().nullable(),
  /** As stored, sorted. */
  permissions: z.array(z.string()),
});
export type CatalogueRole = z.infer<typeof CatalogueRoleSchema>;

/** `GET /v1/rbac/roles`: every role the API enforces, built-in and custom. */
export const CatalogueRolesResponseSchema = z.object({ roles: z.array(CatalogueRoleSchema) });
export type CatalogueRolesResponse = z.infer<typeof CatalogueRolesResponseSchema>;

/** One row of the network admin's read-only permissions table (#871). */
export const CataloguePermissionSchema = z.object({
  key: z.string(),
  description: z.string(),
  resource: z.string(),
  action: z.string(),
  /** Exposes or processes decrypted personal data. */
  personal_data: z.boolean(),
  /** No longer in the code's catalogue; kept so stored roles still resolve. */
  retired: z.boolean(),
  /** Keys of the roles that grant it, sorted. */
  granted_by_roles: z.array(z.string()),
});
export type CataloguePermission = z.infer<typeof CataloguePermissionSchema>;

/** `GET /v1/rbac/permissions`: every permission in the catalogue, retired included. */
export const CataloguePermissionsResponseSchema = z.object({
  permissions: z.array(CataloguePermissionSchema),
});
export type CataloguePermissionsResponse = z.infer<typeof CataloguePermissionsResponseSchema>;

/** One additional-role assignment on the wire. */
export const RoleAssignmentSchema = z.object({
  id: z.string(),
  role_key: z.string(),
  org_id: z.string(),
  granted_by: z.string().nullable(),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  /** Not revoked and not expired. */
  live: z.boolean(),
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/** `GET /v1/user/roles/:id`: base roles (derived) and additional roles. */
export const UserRolesResponseSchema = z.object({
  base: z.array(z.object({ role_key: z.string(), org_id: z.string() })),
  additional: z.array(RoleAssignmentSchema),
  /** Additional roles the caller may assign to this user, per organisation. */
  assignable: z.array(z.object({ role_key: z.string(), org_id: z.string() })),
});
export type UserRolesResponse = z.infer<typeof UserRolesResponseSchema>;

/** `POST /v1/user/role/assign/:id`. Omit `days` for the role's longest validity. */
export const AssignRoleRequestSchema = z
  .object({
    role_key: z.string().min(1),
    org_id: z.string().uuid(),
    days: z.number().int().positive().optional(),
  })
  .strict();
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

/** `POST /v1/user/role/revoke/:id`. */
export const RevokeRoleRequestSchema = z
  .object({ role_key: z.string().min(1), org_id: z.string().uuid() })
  .strict();
export type RevokeRoleRequest = z.infer<typeof RevokeRoleRequestSchema>;

/** `POST /v1/user/role/revoke/:id` response. */
export const RevokeRoleResponseSchema = z.object({ revoked: z.boolean() });
export type RevokeRoleResponse = z.infer<typeof RevokeRoleResponseSchema>;

/** `POST /v1/roles/create`: a custom role (network admin). */
export const CreateRoleRequestSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
    account_type: z.enum(['admin', 'coordinator']),
    assignable_org_types: z.array(OrgTypeSchema).min(1),
    assigned_by: z.string().min(1),
    max_days: z.number().int().positive().nullable().default(null),
    permissions: z.array(z.string()).min(1),
  })
  .strict();
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

/** `PATCH /v1/roles/update/:key`: change a custom role (the key and account type are fixed). */
export const UpdateRoleRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(300).optional(),
    assignable_org_types: z.array(OrgTypeSchema).min(1).optional(),
    assigned_by: z.string().min(1).optional(),
    max_days: z.number().int().positive().nullable().optional(),
    permissions: z.array(z.string()).min(1).optional(),
  })
  .strict();
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;
