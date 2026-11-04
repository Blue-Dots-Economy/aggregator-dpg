/**
 * Coordinator-specific DTOs and Zod schemas — actor / role / status enums,
 * consent records, and the registration payload shape that drives the
 * `aggregators` table.
 *
 * Source of truth for the table shape is the Drizzle definitions in
 * `@aggregator-dpg/db-schema/schema`.
 *
 * @module @aggregator-dpg/shared-primitives/aggregator
 */

import { z } from 'zod';

import {
  BecknContactSchema,
  BecknLocationSchema,
  type BecknContact,
  type BecknLocation,
} from '../beckn/index.js';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const ActorTypeSchema = z.enum(['aggregator', 'seeker', 'provider']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

/**
 * Coordinator domain id. An open string: each network's `network.json` lists
 * the valid values. Callers validate against `getNetworkConfig().domainIds`.
 */
export const RoleTypeSchema = z.string().min(1);
export type RoleType = z.infer<typeof RoleTypeSchema>;

/** Alias of {@link RoleTypeSchema}. */
export const DomainIdSchema = RoleTypeSchema;
export type DomainId = RoleType;

export const AggregatorStatusSchema = z.enum(['pending', 'active', 'inactive', 'retired']);
export type AggregatorStatus = z.infer<typeof AggregatorStatusSchema>;

export const DecisionMadeSchema = z.enum(['pending', 'approved', 'rejected']);
export type DecisionMade = z.infer<typeof DecisionMadeSchema>;

// ─── Consent ────────────────────────────────────────────────────────────────

/**
 * Stored consent shape. `value` may be any boolean. Registration uses
 * {@link RegistrationConsentSchema}, which requires `true`.
 */
export const ConsentRecordSchema = z
  .object({
    value: z.boolean(),
    given_at: z.string().datetime(),
    valid_till: z.string().datetime(),
  })
  .strict();

export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/**
 * Registration-time consent shape. `value` must be `true`, so an API caller
 * cannot submit `value: false`.
 */
export const RegistrationConsentSchema = ConsentRecordSchema.extend({
  value: z.literal(true),
});

// ─── Registration payload (slim — what the signup form submits) ─────────────

/**
 * The registration's domain ids as a list.
 *
 * @param type - The payload's `type`: one id or a list.
 * @returns The ids, in the order given.
 */
export function registrationDomains(type: string | readonly string[]): string[] {
  return typeof type === 'string' ? [type] : [...type];
}

export const RegistrationPayloadSchema = z
  .object({
    name: z.string().min(2).max(200),
    /**
     * The domain ids the coordinator serves: one id, or a non-empty list
     * without repeats. Stored in `users.serves`, which routes that write
     * participant data check. The first id is also copied to the Keycloak
     * `aggregator_type` attribute, which nothing checks.
     */
    type: z.union([
      RoleTypeSchema,
      z
        .array(RoleTypeSchema)
        .min(1)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: 'domain ids must not repeat',
        }),
    ]),
    url: z.string().url().max(2048).optional(),
    /**
     * Sub-org, division or institution name. Present only when the
     * deployment's registration schema asks for it. Stored in
     * `users.profile`.
     */
    sub_org_name: z.string().max(200).optional(),
    contact: BecknContactSchema,
    locations: z.array(BecknLocationSchema).default([]),
    consent: RegistrationConsentSchema,
  })
  .strict();

export type RegistrationPayload = z.infer<typeof RegistrationPayloadSchema>;

// Re-export the inferred Beckn types for callers that only import from this subpath.
export type { BecknContact, BecknLocation };
