/**
 * Aggregator-specific DTOs and Zod schemas — actor / role / status enums,
 * persona and service registry references, public-key entries, consent
 * records, and the registration + profile payload shapes that drive the
 * two-table aggregator schema (`aggregators` + `aggregator_profile`).
 *
 * Source of truth for the table shape is migration 0005
 * (`apps/api/drizzle/migrations/0005_aggregator_profile.sql`) and the Drizzle
 * definitions in `@aggregator-dpg/db-schema/schema`.
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
 * Aggregator participant focus. An aggregator registers as `seeker` OR
 * `provider` — never both. The API enforces this at signup and on every
 * bulk-upload / public-registration-link write by comparing the body's
 * participant_type to the `aggregator_type` JWT claim.
 *
 * @deprecated The signalstack network is the source of truth for domain
 * ids — different networks use different names (`learner`/`tutor` for
 * yellow_dot, etc.). Prefer {@link DomainIdSchema} for new code; this
 * enum stays for backward compatibility while existing call sites
 * migrate.
 */
export const RoleTypeSchema = z.enum(['seeker', 'provider']);
export type RoleType = z.infer<typeof RoleTypeSchema>;

/**
 * Open domain id — accepts any string the network's `network.json`
 * declares. Use this in new code instead of {@link RoleTypeSchema} so
 * the aggregator stays network-agnostic. Callers validate the value
 * against `getNetworkConfig().domainIds` at the route boundary.
 */
export const DomainIdSchema = z.string().min(1);
export type DomainId = z.infer<typeof DomainIdSchema>;

export const AggregatorStatusSchema = z.enum(['pending', 'active', 'inactive', 'retired']);
export type AggregatorStatus = z.infer<typeof AggregatorStatusSchema>;

export const DecisionMadeSchema = z.enum(['pending', 'approved', 'rejected']);
export type DecisionMade = z.infer<typeof DecisionMadeSchema>;

// ─── Schema-registry references ─────────────────────────────────────────────

export const PersonaRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type PersonaRef = z.infer<typeof PersonaRefSchema>;

export const ServiceRefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export type ServiceRef = z.infer<typeof ServiceRefSchema>;

// ─── Verified certificate ───────────────────────────────────────────────────

export const PublicKeyEntrySchema = z
  .object({
    key_id: z.string().min(1),
    public_key: z.string().min(1),
    algorithm: z.string().min(1),
    valid_till: z.string().datetime(),
    revoked_at: z.string().datetime().optional(),
  })
  .strict();

export type PublicKeyEntry = z.infer<typeof PublicKeyEntrySchema>;

// ─── Consent ────────────────────────────────────────────────────────────────

/**
 * Stored consent shape — used by DB types and reads. The DB CHECK only
 * enforces `value is boolean`. The registration route narrows further with
 * {@link RegistrationConsentSchema} to require an affirmative `true`.
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
 * Registration-time consent shape — `value` must be literal `true`. Mirrors
 * the JSON Schema `const: true` in `registration.v1.json` so that signup
 * cannot complete without ticking the T&C checkbox.
 */
export const RegistrationConsentSchema = ConsentRecordSchema.extend({
  value: z.literal(true),
});

// ─── Registration payload (slim — what the signup form submits) ─────────────

export const RegistrationPayloadSchema = z
  .object({
    name: z.string().min(2).max(200),
    /**
     * Aggregator's domain focus — `seeker` or `provider`. Mirrored to the
     * Keycloak `aggregator_type` user attribute and published in the JWT
     * claim of the same name. Routes that write participant data compare
     * the request body to that claim.
     */
    type: RoleTypeSchema,
    url: z.string().url().max(2048).optional(),
    contact: BecknContactSchema,
    locations: z.array(BecknLocationSchema).default([]),
    consent: RegistrationConsentSchema,
  })
  .strict();

export type RegistrationPayload = z.infer<typeof RegistrationPayloadSchema>;

// ─── Profile payload (post-login completion via PATCH) ──────────────────────

export const ProfilePayloadSchema = z
  .object({
    contact_name: z.string().min(1).max(200).optional(),
    personas: z.array(PersonaRefSchema).optional(),
    services: z.array(ServiceRefSchema).optional(),
    verified_certificate: z.array(PublicKeyEntrySchema).optional(),
  })
  .strict();

export type ProfilePayload = z.infer<typeof ProfilePayloadSchema>;

// ─── Aggregator view (server → client merged response) ──────────────────────

/**
 * Merged read-shape returned by `GET /aggregator-profile`. Joins the
 * `aggregators` row with its 1:1 `aggregator_profile` partner so the client
 * sees the full Beckn-aligned aggregator record in one payload.
 */
export const AggregatorViewSchema = z
  .object({
    id: z.string().uuid(),
    org_slug: z.string().min(1),
    actor_type: ActorTypeSchema,
    name: z.string().min(1),
    type: RoleTypeSchema.nullable(),
    url: z.string().url().nullable(),

    contact: BecknContactSchema,
    locations: z.array(BecknLocationSchema),

    // From aggregator_profile
    contact_name: z.string().nullable(),
    personas: z.array(PersonaRefSchema),
    services: z.array(ServiceRefSchema),
    verified_certificate: z.array(PublicKeyEntrySchema),
    profile_completed_at: z.string().datetime().nullable(),

    consent: ConsentRecordSchema,
    status: AggregatorStatusSchema,
    created_by: z.string(),
    updated_by: z.string(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict()
  .refine((a) => (a.actor_type === 'aggregator' ? a.type === null : a.type !== null), {
    message: 'type must be null iff actor_type=aggregator',
    path: ['type'],
  });

export type AggregatorView = z.infer<typeof AggregatorViewSchema>;

// Re-export the inferred Beckn types for callers that only import from this subpath.
export type { BecknContact, BecknLocation };
