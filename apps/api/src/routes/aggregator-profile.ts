/**
 * Aggregator profile endpoints (post-login).
 *
 *   GET /v1/aggregators/profile/me
 *     Returns the merged read shape: aggregator (registration-essential
 *     fields) + 1:1 `aggregator_profile` (post-login fields) + identity
 *     fragment derived from JWT / Keycloak.
 *
 *   PATCH /v1/aggregators/profile/me
 *     Single endpoint that splits writes by destination:
 *
 *       body.aggregator.contact    → Keycloak FIRST (mirror is authoritative
 *                                    for phone+email), then DB
 *       body.aggregator.*          → DB only (name / url / locations / consent)
 *       body.profile.*             → `aggregator_profile` only
 *
 *     `org_slug` is rejected (immutable; DB trigger enforces too). On a
 *     profile-only PATCH the route stamps `profile_completed_at` once all
 *     required profile fields (`contact_name`, ≥1 persona, ≥1 service) are
 *     present.
 *
 * Authorisation: Bearer access token from Keycloak with the custom
 * `aggregator_id` claim mapped from the user attribute.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withAggregatorBaggage } from '@aggregator-dpg/telemetry';
import {
  ConsentRecordSchema,
  PersonaRefSchema,
  PublicKeyEntrySchema,
  ServiceRefSchema,
} from '@aggregator-dpg/shared-primitives/aggregator';
import type {
  BecknContact,
  PersonaRef,
  PublicKeyEntry,
  ServiceRef,
} from '@aggregator-dpg/shared-primitives/aggregator';
import { BecknContactSchema, BecknLocationSchema } from '@aggregator-dpg/shared-primitives/beckn';
import { authenticate, type AuthContext } from '../services/auth/access-token.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import {
  getAggregatorProfileStore,
  type AggregatorProfile,
} from '../services/aggregator-profile-store/index.js';
import { getIdpAdmin, KC_ATTR } from '../services/idp-admin/index.js';
import type { IdpUser } from '../services/idp-admin/index.js';
import { normalisePhone } from '../services/phone.js';
import { getSchemaRegistry } from '../services/schema-registry/index.js';
import { httpError } from '../errors/http-error.js';

// ─── Body schemas ───────────────────────────────────────────────────────────

const AggregatorPatchSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    url: z.string().url().max(2048).nullable().optional(),
    contact: BecknContactSchema.optional(),
    locations: z.array(BecknLocationSchema).optional(),
    consent: ConsentRecordSchema.optional(),
  })
  .strict();

const ProfilePatchSchema = z
  .object({
    contact_name: z.string().min(1).max(200).nullable().optional(),
    personas: z.array(PersonaRefSchema).optional(),
    services: z.array(ServiceRefSchema).optional(),
    verified_certificate: z.array(PublicKeyEntrySchema).optional(),
  })
  .strict();

const ProfileUpdateBodySchema = z
  .object({
    aggregator: AggregatorPatchSchema.optional(),
    profile: ProfilePatchSchema.optional(),
  })
  .strict()
  .refine((b) => b.aggregator !== undefined || b.profile !== undefined, {
    message: 'body must include at least one of `aggregator` or `profile`',
  });

export async function registerAggregatorProfileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/aggregators/profile/me', async (req, reply) => {
    const auth = await requireAuth(req);
    return withAggregatorBaggage(auth.aggregatorId, async () => {
      const log = req.log.child({ operation: 'aggregator-profile.read', actor: auth.userId });
      const start = Date.now();

      const aggregatorStore = getAggregatorStore();
      const profileStore = getAggregatorProfileStore();

      const aggregator = await aggregatorStore.findById(auth.aggregatorId);
      if (!aggregator.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(aggregator.error.message) });
      }
      if (!aggregator.value) {
        throw httpError('NOT_FOUND', { detail: 'Aggregator record not found.' });
      }

      const profile = await profileStore.findByAggregatorId(auth.aggregatorId);
      if (!profile.ok) {
        throw httpError('DB_UNAVAILABLE', { cause: new Error(profile.error.message) });
      }
      if (!profile.value) {
        // Registration always inserts a stub profile — should never fire.
        throw httpError('NOT_FOUND', { detail: 'Profile record missing.' });
      }

      const kcUser = await fetchKcUserSafe(auth, log);

      log.info(
        { status: 'success', latency_ms: Date.now() - start, aggregator_id: auth.aggregatorId },
        'profile read',
      );

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        // aggregator.name is now authoritative for display. Fall back to slug
        // only on the (impossible) empty-string edge case.
        org_name: aggregator.value.name || aggregator.value.orgSlug,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        // Profile (1:1)
        contact_name: profile.value.contactName,
        personas: profile.value.personas,
        services: profile.value.services,
        verified_certificate: profile.value.verifiedCertificate,
        profile_completed_at: profile.value.profileCompletedAt?.toISOString() ?? null,
        // Identity (from JWT claim / KC fallback)
        identity: {
          first_name: auth.firstName ?? kcUser?.firstName ?? null,
          last_name: auth.lastName ?? kcUser?.lastName ?? null,
          email: auth.email ?? kcUser?.email ?? aggregator.value.contact.email,
          email_verified: auth.emailVerified ?? false,
          phone:
            auth.phoneNumber ??
            pickAttribute(kcUser, KC_ATTR.PHONE_NUMBER) ??
            aggregator.value.contact.phone,
          phone_verified:
            auth.phoneNumberVerified ?? pickAttribute(kcUser, 'phoneNumberVerified') === 'true',
          active: kcUser?.enabled ?? aggregator.value.status === 'active',
        },
        is_complete: profile.value.profileCompletedAt !== null,
        created_at: aggregator.value.createdAt.toISOString(),
        updated_at:
          profile.value.updatedAt.getTime() > aggregator.value.updatedAt.getTime()
            ? profile.value.updatedAt.toISOString()
            : aggregator.value.updatedAt.toISOString(),
      });
    });
  });

  app.patch('/v1/aggregators/profile/me', async (req, reply) => {
    const auth = await requireAuth(req);
    return withAggregatorBaggage(auth.aggregatorId, async () => {
      const log = req.log.child({ operation: 'aggregator-profile.update', actor: auth.userId });
      const start = Date.now();

      const parsed = ProfileUpdateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError('SCHEMA_VALIDATION', {
          detail: 'Request body failed shape validation.',
          fields: { issues: parsed.error.issues },
        });
      }
      const body = parsed.data;

      const aggregatorStore = getAggregatorStore();
      const profileStore = getAggregatorProfileStore();

      // ─── 1. Mirror phone/email to Keycloak FIRST (authoritative). ──────────
      // If KC fails, abort before touching the DB so we never have the DB
      // ahead of Keycloak.
      let normalisedContact: BecknContact | undefined;
      if (body.aggregator?.contact) {
        const raw = body.aggregator.contact;
        const phoneR = normalisePhone(raw.phone);
        if (!phoneR.ok) {
          throw httpError('INVALID_PHONE', {
            detail: phoneR.error.message,
            fields: { input: raw.phone },
          });
        }
        normalisedContact = { ...raw, phone: phoneR.value };

        const idp = getIdpAdmin();
        const kcWrite = await idp.setAttributes(auth.userId, {
          [KC_ATTR.PHONE_NUMBER]: phoneR.value,
        });
        if (!kcWrite.ok) {
          log.error(
            {
              status: 'failure',
              sub_operation: 'idp.setAttributes.contact',
              code: kcWrite.error.code,
              cause: kcWrite.error.message,
            },
            'failed to mirror phone to Keycloak — aborting before DB write',
          );
          throw httpError('IDP_UNAVAILABLE', { cause: kcWrite.error });
        }
      }

      // ─── 2. Aggregator-table updates ──────────────────────────────────────
      let aggregatorUpdated = false;
      if (body.aggregator !== undefined) {
        const patch: Parameters<typeof aggregatorStore.update>[1] = {
          updatedBy: auth.userId,
        };
        if (body.aggregator.name !== undefined) patch.name = body.aggregator.name;
        if (body.aggregator.url !== undefined) patch.url = body.aggregator.url;
        if (normalisedContact !== undefined) patch.contact = normalisedContact;
        if (body.aggregator.locations !== undefined) patch.locations = body.aggregator.locations;
        if (body.aggregator.consent !== undefined) patch.consent = body.aggregator.consent;

        const result = await aggregatorStore.update(auth.aggregatorId, patch);
        if (!result.ok) {
          throw httpError(mapAggregatorUpdateError(result.error.code), {
            cause: new Error(result.error.message),
          });
        }
        aggregatorUpdated = true;
      }

      // ─── 3. Profile-table updates + completion check ──────────────────────
      let profileUpdated = false;
      if (body.profile !== undefined) {
        // Validate persona / service IDs against the schema registry. Unknown
        // IDs are rejected as SCHEMA_VALIDATION — Beckn catalogs require
        // canonical schema refs, not free-form strings.
        const registry = getSchemaRegistry();
        const unknownPersonas = (body.profile.personas ?? []).filter(
          (p) => !registry.hasPersona(p.id),
        );
        const unknownServices = (body.profile.services ?? []).filter(
          (s) => !registry.hasService(s.id),
        );
        if (unknownPersonas.length > 0 || unknownServices.length > 0) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'One or more persona/service IDs are not in the schema registry.',
            fields: {
              unknown_personas: unknownPersonas.map((p) => p.id),
              unknown_services: unknownServices.map((s) => s.id),
            },
          });
        }

        const patch: Parameters<typeof profileStore.update>[1] = {
          updatedBy: auth.userId,
        };
        if (body.profile.contact_name !== undefined) patch.contactName = body.profile.contact_name;
        if (body.profile.personas !== undefined) patch.personas = body.profile.personas;
        if (body.profile.services !== undefined) patch.services = body.profile.services;
        if (body.profile.verified_certificate !== undefined) {
          patch.verifiedCertificate = body.profile.verified_certificate;
        }

        const existing = await profileStore.findByAggregatorId(auth.aggregatorId);
        if (!existing.ok || !existing.value) {
          throw httpError('NOT_FOUND', { detail: 'Profile record missing.' });
        }
        // Compute the post-write profile state to decide whether to stamp
        // `profile_completed_at` (or clear it if a previously-complete profile
        // is now incomplete).
        const next: AggregatorProfile = {
          ...existing.value,
          contactName:
            patch.contactName !== undefined ? patch.contactName : existing.value.contactName,
          personas: patch.personas ?? existing.value.personas,
          services: patch.services ?? existing.value.services,
          verifiedCertificate: patch.verifiedCertificate ?? existing.value.verifiedCertificate,
        };
        const complete = isProfileComplete(next);
        const wasComplete = existing.value.profileCompletedAt !== null;
        if (complete && !wasComplete) {
          patch.profileCompletedAt = new Date();
        } else if (!complete && wasComplete) {
          patch.profileCompletedAt = null;
        }

        const result = await profileStore.update(auth.aggregatorId, patch);
        if (!result.ok) {
          if (result.error.code === 'NOT_FOUND') {
            throw httpError('NOT_FOUND', {
              detail: 'Profile record missing.',
              cause: new Error(result.error.message),
            });
          }
          throw httpError('DB_UNAVAILABLE', { cause: new Error(result.error.message) });
        }
        profileUpdated = true;
      }

      log.info(
        {
          status: 'success',
          latency_ms: Date.now() - start,
          aggregator_id: auth.aggregatorId,
          aggregator_updated: aggregatorUpdated,
          profile_updated: profileUpdated,
        },
        'profile updated',
      );

      // Echo the merged view so the client doesn't need an extra GET.
      const aggregator = await aggregatorStore.findById(auth.aggregatorId);
      const profile = await profileStore.findByAggregatorId(auth.aggregatorId);
      if (!aggregator.ok || !aggregator.value || !profile.ok || !profile.value) {
        throw httpError('INTERNAL', { detail: 'Post-write read failed.' });
      }

      return reply.send({
        aggregator_id: auth.aggregatorId,
        org_slug: aggregator.value.orgSlug,
        name: aggregator.value.name,
        actor_type: aggregator.value.actorType,
        type: aggregator.value.type,
        url: aggregator.value.url,
        contact: aggregator.value.contact,
        locations: aggregator.value.locations,
        consent: aggregator.value.consent,
        status: aggregator.value.status,
        contact_name: profile.value.contactName,
        personas: profile.value.personas,
        services: profile.value.services,
        verified_certificate: profile.value.verifiedCertificate,
        profile_completed_at: profile.value.profileCompletedAt?.toISOString() ?? null,
        is_complete: profile.value.profileCompletedAt !== null,
        updated_at:
          profile.value.updatedAt.getTime() > aggregator.value.updatedAt.getTime()
            ? profile.value.updatedAt.toISOString()
            : aggregator.value.updatedAt.toISOString(),
      });
    });
  });
}

async function fetchKcUserSafe(auth: AuthContext, log: FastifyBaseLogger): Promise<IdpUser | null> {
  try {
    const result = await getIdpAdmin().findById(auth.userId);
    if (result.ok) return result.value ?? null;
    log.warn(
      { sub_operation: 'fetchKcUser', code: result.error.code, hint: result.error.message },
      'failed to load KC user — falling back to JWT claims',
    );
    return null;
  } catch (err) {
    log.warn(
      {
        sub_operation: 'fetchKcUser',
        cause: err instanceof Error ? err.message : String(err),
      },
      'failed to load KC user (threw)',
    );
    return null;
  }
}

function pickAttribute(user: IdpUser | null, name: string): string | undefined {
  const v = user?.attributes?.[name];
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].length > 0) return v[0];
  return undefined;
}

async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
  const result = await authenticate(req);
  if (result.ok) return result.context;
  const code = result.error.code === 'MISSING_AGGREGATOR_ID' ? 'FORBIDDEN' : 'UNAUTHORIZED';
  throw httpError(code, {
    detail: result.error.message,
    fields: { reason: result.error.code },
  });
}

/**
 * "Profile complete" rule: at minimum the contact-name display label is
 * present, plus at least one persona and at least one service so the
 * aggregator is discoverable in Beckn catalog queries.
 */
function isProfileComplete(p: {
  contactName: string | null;
  personas: PersonaRef[];
  services: ServiceRef[];
  verifiedCertificate: PublicKeyEntry[];
}): boolean {
  if (!p.contactName || p.contactName.trim() === '') return false;
  if (p.personas.length === 0) return false;
  if (p.services.length === 0) return false;
  return true;
}

function mapAggregatorUpdateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'CHECK_VIOLATION'
    | 'DB_UNAVAILABLE',
): Parameters<typeof httpError>[0] {
  switch (code) {
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    default:
      return 'DB_UNAVAILABLE';
  }
}
