/**
 * Public contract for access decisions in aggregator-dpg (`@aggregator-dpg/rbac`).
 *
 * Defines the fixed capability catalogue, the shape of an access question
 * ({@link DecisionInput}) and the {@link AuthorizerBase} every decision
 * engine implements. The question is "does the actor hold this capability";
 * which targets the actor reaches is answered outside the policy (design
 * decision D3). The OPA-backed engine and the in-memory fake both extend
 * it, so callers depend only on this file.
 *
 * Design: `docs/rbac/rbac-design-aggregator.md`; catalogue:
 * `docs/rbac/rbac-permissions-and-roles.md`.
 *
 * @module @aggregator-dpg/rbac/interface
 */

import { z } from 'zod';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/** Every capability in the catalogue. Stable IDs: never renamed, only deprecated. */
export const CAPABILITIES = [
  'profiles.view',
  'profiles.export',
  'profiles.view_pii',
  'profiles.onboard',
  'profiles.verify',
  'profiles.retire',
  'profiles.move',
  'profiles.act_on_behalf',
  'campaigns.run',
  'orgs.onboard',
  'orgs.block',
  'org.manage',
  'contact.unmask',
  'agreement.manage',
  'network.administer',
] as const;

/** Zod schema for one capability ID. */
export const CapabilitySchema = z.enum(CAPABILITIES);

/** One capability ID, e.g. `profiles.view_pii`. */
export type Capability = z.infer<typeof CapabilitySchema>;

/** Account types of the user-org refactor (`users.user_type`). */
export const UserTypeSchema = z.enum(['admin', 'coordinator']);

/** Account type: `admin` (organisation owner) or `coordinator`. */
export type UserType = z.infer<typeof UserTypeSchema>;

/** Organisation types of the user-org refactor (`organisations.org_type`). */
export const OrgTypeSchema = z.enum(['network_facilitator', 'aggregator']);

/** Organisation type: the single `network_facilitator` root, or an `aggregator`. */
export type OrgType = z.infer<typeof OrgTypeSchema>;

/** How the actor relates to an organisation it may act through. */
export const OrgRelationSchema = z.enum(['owner', 'member']);

/** `owner` = the actor is the organisation's `org_owner`; `member` = coordinator of it. Informational: reach is decided outside the policy. */
export type OrgRelation = z.infer<typeof OrgRelationSchema>;

/** An organisation the actor may act through, with the PermissionSet that caps it. */
export const ActorOrgSchema = z.object({
  id: z.string().min(1),
  orgType: OrgTypeSchema,
  relation: OrgRelationSchema,
  /** The organisation's effective PermissionSet: its override, else its `org_type` default. */
  capabilities: z.array(CapabilitySchema),
});

/** An organisation the actor may act through. */
export type ActorOrg = z.infer<typeof ActorOrgSchema>;

/** A capability granted to one user on top of their role (e.g. PII Access). */
export const GrantSchema = z.object({
  capability: CapabilitySchema,
  /** Epoch milliseconds; the grant stops working at this instant. */
  expiresAt: z.number().int().nonnegative(),
});

/** A per-user grant. */
export type Grant = z.infer<typeof GrantSchema>;

/** The caller, as resolved from the database for one request. */
export const ActorSchema = z.object({
  userId: z.string().min(1),
  userType: UserTypeSchema,
  /** False for pending, rejected or disabled accounts: they hold nothing. */
  active: z.boolean(),
  /** The role's capabilities from `config/rbac.yaml`. */
  roleCapabilities: z.array(CapabilitySchema),
  orgs: z.array(ActorOrgSchema),
  grants: z.array(GrantSchema),
});

/** The caller of one request. */
export type Actor = z.infer<typeof ActorSchema>;

/** One access question. */
export const DecisionInputSchema = z.object({
  capability: CapabilitySchema,
  actor: ActorSchema,
  /** Epoch milliseconds, for grant expiry. */
  now: z.number().int().nonnegative(),
});

/** One access question. */
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

/** The answer: allowed or not, with machine-readable reasons for a deny. */
export const DecisionSchema = z.object({
  allow: z.boolean(),
  reasons: z.array(z.string()),
});

/** The answer to one access question. */
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Abstract decision engine.
 *
 * Concrete engines (OPA over HTTP, the in-memory fake) extend this class and
 * implement {@link AuthorizerBase.decide} with the exact signature.
 */
export abstract class AuthorizerBase {
  /**
   * Answers one access question.
   *
   * @param input - The capability, the actor and the current time.
   * @returns Ok with the decision, or Err when the engine cannot answer
   *   (unreachable, timed out, malformed reply). Callers treat Err as a deny.
   */
  abstract decide(input: DecisionInput): Promise<Result<Decision, BaseError>>;
}
