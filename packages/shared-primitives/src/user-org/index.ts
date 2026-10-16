/**
 * Wire schemas of the console APIs `/v1/user/*` and `/v1/org/*` (user & org
 * Phase 5). Shared by the API (zod → OpenAPI) and the web BFF / console.
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

/** A person's contact as the console shows it (plain within reach; P5-8). */
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
});
export type MeOrg = z.infer<typeof MeOrgSchema>;

/** `GET /v1/user/read/me`. RBAC adds `capabilities` later. */
export const MeResponseSchema = z.object({
  kind: z.enum(['admin', 'coordinator']),
  user: z.object({ id: z.string(), contact: PersonContactSchema }),
  orgs: z.array(MeOrgSchema),
  is_network_admin: z.boolean(),
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
  url: z.string().nullable(),
  locations: z.array(BecknLocationSchema),
  legal_name: z.string().nullable(),
  gst_number: z.string().nullable(),
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

/** `PATCH /v1/org/metadata/update/:id`. `name` is the network admin's only. */
export const OrgMetadataUpdateRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    url: z.string().trim().url().max(2048).nullable().optional(),
    locations: z.array(BecknLocationSchema).max(25).optional(),
    legal_name: z.string().trim().max(200).nullable().optional(),
    gst_number: z.string().trim().max(32).nullable().optional(),
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
