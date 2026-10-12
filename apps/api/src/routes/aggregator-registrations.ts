/**
 * Aggregator registration endpoints.
 *
 * Public submission flow:
 *   1. Validate body against `RegistrationPayloadSchema` (Zod) AND
 *      `registration.v1.json` (Ajv). The JSON Schema is the authoritative
 *      contract that drives the UI form; Zod gives type-safe parsing.
 *   2. Normalise `contact.phone` to E.164.
 *   3. Pre-check email + phone uniqueness in BOTH the DB and Keycloak. The
 *      DB has its own UNIQUE indexes (`contact_phone`, `contact_email`),
 *      but checking up-front avoids inserting an orphan aggregator row
 *      that then has to be rolled back.
 *   4. Generate `org_slug = slugFromName(body.name)` with retry on the
 *      (statistically tiny) suffix collision.
 *   5. INSERT the coordinator into `users` (status='pending', `serves` from
 *      `type`) and its registration consent row into `consent_record`, in one
 *      transaction (0029). Schema-declared fields with no column of their own
 *      go into the `profile` jsonb, tagged by `profile_ref`.
 *   6. Create the Keycloak user with attributes
 *      { aggregator_id, aggregator_type, phoneNumber, decision_made: 'pending' }.
 *      Email is a built-in field. The user is created disabled — login is
 *      blocked until the admin approval flow flips `decision_made → approved`
 *      and enables the KC user. `aggregator_type` (seeker | provider) is
 *      published as a JWT claim and drives the single-type enforcement on
 *      bulk uploads and public registration links.
 *   7. Mint approve / reject JWTs and email the configured admins.
 *
 * Failures throw `httpError(<CODE>)`. A consent-ledger failure rolls the whole
 * insert back inside its transaction; a KC failure after the commit deletes the
 * coordinator row (its consent row stays, unlinked).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import type { BecknContact, BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { stampConsent } from '../services/registration-consent.js';
import type {
  Aggregator,
  LegacyOrgDetails,
  RecordConsentHook,
} from '../services/aggregator-store/interface.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { getRegistrationInvitesStore } from '../services/registration-invites-store/index.js';
import { verifyInviteToken } from '../services/invite-token.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
import { sendAdminReviewEmail } from '../services/registration-notify.js';
import { defaultOrgOwnerEmail } from '../config.js';
import { coolingRetryAfter } from '../services/registration-cooling.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { resolveProfileRef } from '../services/schema-ref.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { slugFromName } from '../services/slug.js';
import { authenticateAny } from '../services/auth/access-token.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import type { ErrorCode } from '../errors/codes.js';

const SLUG_RETRIES = 3;

// The coordinator submit carries the coordinator's org (`org_id`) or an invite.
// `RegistrationPayloadSchema` is strict (rejects unknown keys), so the route
// body schema must explicitly permit them; the handler validates them against
// the org store.
const CoordinatorRegistrationBodySchema = RegistrationPayloadSchema.extend({
  org_id: z.string().optional(),
  // Coordinator invite token (#700). When present it supersedes `org_id`: the
  // org is taken from the token claim and the invite is consumed on submit.
  invite: z.string().optional(),
});

/**
 * Body keys that already own a typed column on `aggregators`, and so must never
 * be copied into `profile`.
 *
 * `org_id` is excluded too — it is stored as `users.org_id`, not payload data;
 * `url` / `locations` belong to the org (0028).
 * Keeping one authoritative home per field is what stops the jsonb payload and
 * the columns drifting apart.
 */
const AGGREGATOR_COLUMN_BACKED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'url',
  'contact',
  'locations',
  'consent',
  'org_id',
  'invite',
]);

/**
 * Collects the schema-driven fields of a registration body into the `profile`
 * payload.
 *
 * Safe to build generically: the same body is validated against
 * `registration.v1.json` with `additionalProperties: false`, so the schema —
 * not this function — bounds which keys can appear. Adding a field to that
 * schema therefore needs no storage change.
 *
 * @param body - Validated coordinator-registration body.
 * @returns The `profile` payload; `{}` when the deployment declares no extra fields.
 */
function buildAggregatorProfile(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => !AGGREGATOR_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
}

const RegistrationCreatedResponseSchema = z
  .object({
    aggregator_id: z.string(),
    org_slug: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .passthrough();

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/v1/aggregator-registrations/create',
    {
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Submit a new aggregator registration',
        description:
          'Validates submission against config/schemas/aggregator/registration.v1.json, creates a disabled user (login enabled on admin approval), and pushes the org to signalstack. Reached via a non-aggregator Bearer token from Keycloak.',
        body: CoordinatorRegistrationBodySchema,
        response: {
          201: RegistrationCreatedResponseSchema,
          ...errorResponses(400, 401, 409, 500, 503),
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const log = req.log.child({ operation: 'aggregator-registration.create' });
      const start = Date.now();

      // Invite claimed by THIS request (#700). The pending→consumed CAS runs
      // BEFORE anything is created, so the invite — not a best-effort check — is
      // the volume bound on a forwarded link. `inviteCommitted` flips only once
      // the registration has fully provisioned; any other exit (throw, or a
      // reclaim that creates nothing) gives the invite back via the compensating
      // `release()` in the `finally` below, so H4 still holds: an ordinary user
      // error such as a duplicate phone never burns a one-time link.
      let inviteJti: string | null = null;
      let inviteCommitted = false;
      try {
        // Re-send the review link for an existing recoverable record without
        // touching its fields. Shared by the still-pending reclaim path and the
        // rejected-then-cooling-elapsed revive path (#726): both re-use the SAME
        // row and re-mint the link to the reviewer using STORED values — the
        // anonymous submit carries no proof of identity, so honouring the
        // resubmitted name/phone would let a stranger hijack the record.
        const reclaimReview = async (row: Aggregator): Promise<FastifyReply> => {
          await sendAdminReviewEmail(
            {
              aggregatorId: row.id,
              applicantName: row.name,
              applicantEmail: row.contact.email,
              applicantPhone: row.contactPhone,
              ...(row.inviteEmail ? { invitedEmail: row.inviteEmail } : {}),
              ...(await resolveOwnerRouting(row.parentOrgId)),
            },
            log,
          );
          log.info(
            {
              status: 'success',
              latency_ms: Date.now() - start,
              aggregator_id: row.id,
              reclaim: true,
            },
            'registration re-submitted — review link re-sent (no field change)',
          );
          // v1 records consent only on fresh registration, not on reclaim (deliberate).
          return reply.status(200).send({
            aggregator_id: row.id,
            org_slug: row.orgSlug,
            status: 'pending',
            message: 'Registration re-submitted. A fresh approval link has been sent for review.',
          });
        };

        // Every backend API requires a Bearer token. Registration is reached
        // anonymously by the user, so the BFF attaches a Keycloak service-
        // account token (client_credentials grant on the `aggregator-bff`
        // confidential client). `authenticateAny` only checks the JWT
        // signature + issuer/exp; it does not require an `aggregator_id`
        // claim because the caller is a service principal, not a user.
        const auth = await authenticateAny(req);
        if (!auth.ok) {
          throw httpError('UNAUTHORIZED', {
            detail: auth.error.message,
            fields: { reason: auth.error.code },
          });
        }

        // `schema.body` already validated against `RegistrationPayloadSchema`
        // (the zod validator compiler replaces `req.body` with the parse
        // output), so the typed body can be consumed directly here.
        const body = req.body as z.infer<typeof RegistrationPayloadSchema>;

        // `org_id` is an org-hierarchy field outside the form's JSON Schema
        // contract; strip it before Ajv so the schema in `config/` stays the
        // single authority for the form shape.
        const {
          org_id: _orgIdField,
          invite: _inviteField,
          ...formBody
        } = req.body as Record<string, unknown>;

        // JSON Schema is the authoritative contract — keeps the form rules in
        // `config/` rather than code.
        const validate = await getRegistrationValidator();
        if (!validate(formBody)) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'Payload failed JSON Schema validation.',
            fields: { issues: validate.errors ?? [] },
          });
        }
        const phoneResult = normalisePhone(body.contact.phone);
        if (!phoneResult.ok) {
          throw httpError('INVALID_PHONE', {
            detail: phoneResult.error.message,
            // Key it `phone` (not `input`) so the logger's `*.phone` redact path
            // masks the raw number if this error is ever logged.
            fields: { phone: body.contact.phone },
          });
        }
        const phoneE164 = phoneResult.value;
        // Persist the normalised E.164 representation so DB queries + Keycloak
        // attribute reads agree on a single canonical form.
        const contact: BecknContact = {
          ...body.contact,
          // Zod has already lowercased the email via the transform — keep it.
          phone: phoneE164,
        };

        const aggregatorStore = getAggregatorStore();
        const idp = getIdpAdmin();

        // Server-stamp the consent timestamp so the recorded value reflects
        // when the API actually accepted the registration, not whatever the
        // client clock reported. `valid_till` stays caller-supplied but is
        // clamped to a hard ceiling so a misbehaving form can not store a
        // 1000-year consent window. Computed early so it is in scope for both
        // the reclaim path and the new-registration path below.
        const serverConsent = stampConsent(body.consent);
        if (!serverConsent) {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'consent.valid_till must be in the future.',
            fields: { 'consent.valid_till': 'invalid' },
          });
        }

        // Rate limit per (ip, email) (spec A6). This bounds submission volume on
        // an endpoint that provisions a Keycloak user and sends mail, so it has
        // to apply in BOTH modes — it used to sit inside the org-hierarchy
        // branch below, which left the flat deployment shape unlimited.
        // Deliberately fail-open (see `submit-rate.ts`): this is a public
        // pre-login path, and a downed Redis must not block registration.
        const rl = await checkSubmitRate(`${req.ip}|${contact.email}`);
        if (!rl.allowed) {
          void reply.header('Retry-After', String(rl.retryAfterSeconds));
          throw httpError('RATE_LIMITED', {
            detail: `Retry in ${rl.retryAfterSeconds}s.`,
            fields: { retry_after_seconds: rl.retryAfterSeconds },
          });
        }

        // The coordinator's org (spec §6.2; always required since 0028): an
        // *active* aggregator org; the link lives in `users.org_id`.
        let parentOrgId: string;
        let orgIsDefault = false;
        // Email the invite was addressed to (#701). A coordinator MAY register with
        // a different email than they were invited at; we keep the invited address
        // for provenance so the approving owner can see who was originally targeted.
        let inviteEmailClaim: string | null = null;
        {
          const orgStore = getAggregatorOrgStore();
          const reqInvite = (req.body as { invite?: string }).invite;

          // Invite-bound path (#700): when the submission carries an invite token
          // it supersedes the org selector. The org comes from the CLAIM, the
          // recipient email is enforced, and the invite is claimed (CAS) before
          // anything is created. The token is a bearer credential — every check
          // below re-validates against the DB and never trusts a hidden field.
          if (reqInvite) {
            const verified = await verifyInviteToken(reqInvite);
            if (!verified.ok) {
              throw httpError(
                verified.error.code === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_INVALID',
              );
            }
            // The coordinator may register with a different email than the invite
            // was sent to (#701) — the invited address is kept as provenance and
            // surfaced to the approving owner, not enforced. The invite itself is
            // still the gate (valid + pending + org active + single-use).
            inviteEmailClaim = verified.email.trim().toLowerCase();
            const inviteStore = getRegistrationInvitesStore();
            // Re-validate the org from the CLAIM independently (§4.4.4).
            const org = await orgStore.findById(verified.org);
            if (!org.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(org.error.message),
                fields: { sub_operation: 'orgStore.findById' },
              });
            }
            // Invites are minted for real orgs only; the Default org has no owner
            // console to invite from.
            if (org.value?.status !== 'active' || org.value.isDefault) {
              throw httpError('TARGET_ORG_INACTIVE');
            }
            const ownerMatch = await orgStore.findByOwnerEmail(contact.email);
            if (ownerMatch.ok && ownerMatch.value) {
              throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: contact.email } });
            }
            // Claim the invite HERE, before anything is created (§4.4.6). A
            // read-only pre-check cannot bound volume: between the read and a
            // deferred CAS this handler creates the aggregator, records consent
            // and calls Keycloak over the network, so N concurrent submits on one
            // forwarded link each passed the read and each created a registration.
            // The unique email/phone constraints only collide when the racers
            // share both, and #701 deliberately leaves the invited email
            // non-enforcing — so the attacker picks distinct ones. Losing this CAS
            // is authoritative, not a warning. Stamp `parent_org_id` from the
            // CLAIM so the approval binding can't mismatch.
            const claimed = await inviteStore.consume(verified.jti);
            if (!claimed.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(claimed.error.message),
                fields: { sub_operation: 'inviteStore.consume' },
              });
            }
            if (claimed.value === null) {
              throw httpError('INVITE_ALREADY_USED', { fields: { email: contact.email } });
            }
            inviteJti = verified.jti;
            parentOrgId = verified.org;
          } else {
            // Selector path: the coordinator picks an active org (spec §6.2).
            const reqOrgId = (req.body as { org_id?: string }).org_id;
            // For one release a body without `org_id` (an old or formerly-flat
            // client, or a pending resubmission) is placed in the Default org
            // with a warning; afterwards it becomes a 400 (D3-13).
            const org = reqOrgId ? await orgStore.findById(reqOrgId) : await orgStore.findDefault();
            if (!reqOrgId && org.ok) {
              if (!org.value) {
                throw httpError('SCHEMA_VALIDATION', { detail: 'org_id is required.' });
              }
              log.warn(
                { status: 'skipped', sub_operation: 'registration.org_id_missing' },
                'registration without org_id — placed in the Default org (accepted for one release)',
              );
            }
            if (!org.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(org.error.message),
                fields: { sub_operation: 'orgStore.findById' },
              });
            }
            // Covers bootstrap (no active org) and an org that went inactive/rejected.
            if (org.value?.status !== 'active') {
              throw httpError('TARGET_ORG_INACTIVE');
            }
            // Owner-also-coordinator (spec A4): a distinct, machine-readable error.
            const ownerMatch = await orgStore.findByOwnerEmail(contact.email);
            if (ownerMatch.ok && ownerMatch.value) {
              throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: contact.email } });
            }
            // The Default org is selectable only while it is the only active
            // org (D3-12): otherwise its coordinators' approvals would bypass
            // every real org's owner. The no-org_id fallback above is exempt for
            // this release.
            if (reqOrgId && org.value.isDefault) {
              const active = await orgStore.listActive();
              if (!active.ok) {
                throw httpError('DB_UNAVAILABLE', {
                  cause: new Error(active.error.message),
                  fields: { sub_operation: 'orgStore.listActive' },
                });
              }
              if (active.value.some((o) => !o.isDefault)) {
                throw httpError('TARGET_ORG_INACTIVE');
              }
            }
            parentOrgId = org.value.id;
            orgIsDefault = org.value.isDefault;
          }
        }

        // A Default-org coordinator names its own organisation (the form shows
        // the name field, as flat mode did); it must never inherit "Default".
        if (orgIsDefault && body.name.trim().toLowerCase() === 'default') {
          throw httpError('SCHEMA_VALIDATION', {
            detail: 'The organisation name cannot be "Default".',
            fields: { field: 'name' },
          });
        }

        // Org details (0028): a real org's url / locations are its own, so the
        // submitted ones are ignored (accepted for one release); a Default-org
        // coordinator keeps its own as `legacy_org_details`, rendered as a
        // fallback since the Default org has no shared value.
        const submittedLocations = (body.locations ?? []).filter(hasLocationContent);
        const ownOrgDetails: LegacyOrgDetails = {
          ...(body.url?.trim() ? { url: body.url.trim() } : {}),
          ...(submittedLocations.length > 0 ? { locations: submittedLocations } : {}),
        };
        if (!orgIsDefault && Object.keys(ownOrgDetails).length > 0) {
          log.warn(
            {
              status: 'skipped',
              sub_operation: 'registration.org_details_ignored',
              fields: Object.keys(ownOrgDetails),
            },
            'org details on a coordinator registration are ignored (they belong to the org)',
          );
        }

        // Pre-check email + phone uniqueness in both stores. The DB
        // generated-column UNIQUEs (contact_phone / contact_email) and Keycloak
        // attribute lookups together give us a deterministic 409 instead of a
        // race between `aggregators` and Keycloak.
        const dbEmail = await aggregatorStore.findByContactEmail(contact.email);
        if (!dbEmail.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(dbEmail.error.message),
            fields: { sub_operation: 'aggregatorStore.findByContactEmail' },
          });
        }
        if (dbEmail.value !== null) {
          const existing = dbEmail.value;
          if (existing.status === 'inactive') {
            // Rejected record (#726): block re-registration until the cooling
            // window elapses, measured from the write-once `rejected_at`. Once it
            // lapses, revive the SAME row to pending (clearing `rejected_at`) and
            // re-send the review link — the disabled KC user is left intact for
            // the approval step, so nothing is deleted or re-created.
            const retryAfter = coolingRetryAfter(existing.rejectedAt, existing.updatedAt);
            if (retryAfter) {
              throw httpError('REGISTRATION_COOLING', {
                fields: { email: contact.email, retry_after: retryAfter },
              });
            }
            const revived = await aggregatorStore.update(existing.id, {
              status: 'pending',
              rejectedAt: null,
              updatedBy: 'self',
            });
            if (!revived.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(revived.error.message),
                fields: { sub_operation: 'aggregatorStore.reviveRejected' },
              });
            }
            return reclaimReview(existing);
          }
          if (existing.status !== 'pending') {
            // active / retired — a live account owns this email.
            throw httpError('USER_EXISTS', { fields: { email: contact.email } });
          }
          // Still pending → re-send the review link, no field change.
          return reclaimReview(existing);
        }

        const dbPhone = await aggregatorStore.findByContactPhone(phoneE164);
        if (!dbPhone.ok) {
          throw httpError('DB_UNAVAILABLE', {
            cause: new Error(dbPhone.error.message),
            fields: { sub_operation: 'aggregatorStore.findByContactPhone' },
          });
        }
        if (dbPhone.value !== null) {
          const existingPhone = dbPhone.value;
          if (existingPhone.status === 'inactive') {
            // Same cooling window (#726) on the phone identity — reached only when
            // the email didn't match any row but a rejected record owns this
            // number. Within the window → 409; elapsed → revive that row and
            // re-send its review link (reuse, no delete).
            const retryAfter = coolingRetryAfter(existingPhone.rejectedAt, existingPhone.updatedAt);
            if (retryAfter) {
              throw httpError('REGISTRATION_COOLING', {
                fields: { phone: phoneE164, retry_after: retryAfter },
              });
            }
            const revived = await aggregatorStore.update(existingPhone.id, {
              status: 'pending',
              rejectedAt: null,
              updatedBy: 'self',
            });
            if (!revived.ok) {
              throw httpError('DB_UNAVAILABLE', {
                cause: new Error(revived.error.message),
                fields: { sub_operation: 'aggregatorStore.reviveRejected' },
              });
            }
            return reclaimReview(existingPhone);
          }
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }

        const kcEmail = await idp.findByEmail(contact.email);
        if (!kcEmail.ok) {
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcEmail.error,
            fields: { sub_operation: 'idp.findByEmail' },
          });
        }
        if (kcEmail.value !== null) {
          throw httpError('USER_EXISTS', { fields: { email: contact.email } });
        }

        // Phone is the OTP-login identity for the portal — Keycloak's OTP
        // authenticator looks users up by the `phoneNumber` attribute. If two
        // users share the same number, the authenticator picks the first
        // match deterministically, which can route a login attempt to a
        // disabled (pending or rejected) account and surface "account
        // disabled". Enforce phone uniqueness here so that never happens.
        const kcPhone = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164);
        if (!kcPhone.ok) {
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcPhone.error,
            fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
          });
        }
        if (kcPhone.value !== null) {
          throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
        }

        // Registration consent is written in the SAME transaction as the
        // coordinator row (0029): a ledger failure leaves no row, contact or
        // consent behind, and nothing has reached Keycloak yet. Fail-closed:
        // never an aggregator without a consent record. Network/brand come from
        // resolveActiveNetwork() so the recorded version matches what the web
        // layer displayed; the config is read before the transaction opens.
        const recordConsent = await aggregatorConsentWriter({
          consent: serverConsent,
          log,
        });

        const aggregator = await createAggregatorWithSlug(aggregatorStore, body.name, {
          type: body.type,
          contact,
          consent: serverConsent,
          recordConsent,
          orgId: parentOrgId,
          legacyOrgDetails:
            orgIsDefault && Object.keys(ownOrgDetails).length > 0 ? ownOrgDetails : null,
          inviteId: inviteJti,
          profile: buildAggregatorProfile(body as unknown as Record<string, unknown>),
          profileRef: resolveProfileRef('registration.v1.json'),
        });
        if (!aggregator.ok) {
          const code = mapStoreCreateError(aggregator.error.code);
          throw httpError(code, {
            cause: new Error(aggregator.error.message),
            ...(code === 'CONSENT_WRITE_FAILED'
              ? { fields: { sub_operation: 'recordAggregatorConsent', rolled_back: true } }
              : {}),
          });
        }
        const { id: aggregatorId, orgSlug } = aggregator.value;

        // Keycloak carries four attributes:
        //   - aggregator_id    reverse pointer to Postgres
        //   - aggregator_type  participant focus, used by single-type enforcement
        //   - phoneNumber      OTP login authenticator
        //   - decision_made    login gate
        // Slug, association, and decision metadata live in Postgres.
        const kcAttributes: Record<string, string> = {
          [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
          [KC_ATTR.AGGREGATOR_TYPE]: body.type,
          [KC_ATTR.PHONE_NUMBER]: phoneE164,
          [KC_ATTR.DECISION_MADE]: 'pending',
        };

        // Split the Beckn `contact.name` into first / last for Keycloak. The
        // signup form already collects the full name, so we don't ask for it
        // again via an UPDATE_PROFILE required action on first login.
        const { firstName, lastName } = splitName(contact.name);
        const kcResult = await idp.createUser({
          email: contact.email,
          username: contact.email,
          phone: phoneE164,
          enabled: false,
          firstName,
          lastName,
          attributes: kcAttributes,
        });
        if (!kcResult.ok) {
          await aggregatorStore.deleteById(aggregatorId);
          if (kcResult.error.code === 'USER_EXISTS') {
            throw httpError('USER_EXISTS', {
              cause: kcResult.error,
              fields: { email: contact.email, rolled_back: true },
            });
          }
          throw httpError('IDP_UNAVAILABLE', {
            cause: kcResult.error,
            fields: { sub_operation: 'idp.createUser', rolled_back: true },
          });
        }

        // Registration is fully provisioned, so the claim taken above stands: stop
        // the `finally` from handing the invite back (#700).
        inviteCommitted = true;

        await sendAdminReviewEmail(
          {
            aggregatorId,
            applicantName: body.name,
            applicantEmail: contact.email,
            applicantPhone: phoneE164,
            ...(inviteEmailClaim ? { invitedEmail: inviteEmailClaim } : {}),
            ...(await resolveOwnerRouting(parentOrgId)),
          },
          log,
        );

        log.info(
          {
            status: 'success',
            latency_ms: Date.now() - start,
            aggregator_id: aggregatorId,
            org_slug: orgSlug,
            keycloak_user_id: kcResult.value.id,
          },
          'aggregator registration submitted',
        );

        return reply.status(201).send({
          aggregator_id: aggregatorId,
          org_slug: orgSlug,
          status: 'pending',
          message: 'Registration submitted. You will receive credentials by email after approval.',
        });
      } finally {
        // Compensating release (#718 review). Reached on every exit that did not
        // create a registration — a thrown error, or a reclaim that only re-sends
        // the review link — so the coordinator keeps their one-time link. Scoped
        // CAS `consumed → pending`: it can only give back the claim THIS request
        // took. Only a mid-request process death leaves an invite consumed with
        // no registration, which the owner resolves by re-minting.
        if (inviteJti && !inviteCommitted) {
          const released = await getRegistrationInvitesStore().release(inviteJti);
          if (!released.ok || released.value === null) {
            log.warn(
              { status: 'failure', sub_operation: 'inviteStore.release', invite_jti: inviteJti },
              'invite release after an incomplete registration did not commit',
            );
          }
        }
      }
    },
  );
}

/**
 * Builds the coordinator's consent-ledger write for `store.create`, which runs
 * it inside the create transaction (0029). The consent config is read here,
 * BEFORE the transaction opens, so no file I/O happens inside it.
 *
 * Fail-closed: a config that cannot be read refuses the registration up front;
 * a ledger write that fails throws inside the transaction, so the store rolls
 * the row and its contact back and answers `CONSENT_WRITE_FAILED`. Failures
 * are logged at `error` with the network and both versions so a missed write
 * is reconstructable.
 *
 * @param consent - The server-stamped registration consent (`valid_till` is stored).
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`.
 * @throws {HttpError} CONSENT_WRITE_FAILED when the consent config cannot be read.
 */
async function aggregatorConsentWriter({
  consent,
  log,
}: {
  consent: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'];
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<RecordConsentHook> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.aggregator.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.aggregator.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordAggregatorConsent',
        status: 'failure',
        error: e instanceof Error ? e.message : String(e),
        network,
        brand: brand ?? null,
      },
      'consent config load failed — registration refused',
    );
    throw httpError('CONSENT_WRITE_FAILED', {
      fields: { sub_operation: 'loadConsentConfig', rolled_back: true },
    });
  }

  return async (executor, aggregatorId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'user',
        subjectId: aggregatorId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordAggregatorConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          aggregator_id: aggregatorId,
          network,
          brand: brand ?? null,
          terms_version: termsVersion,
          privacy_version: privacyVersion,
        },
        'consent ledger write failed — registration rolled back',
      );
      // Throwing inside the store's transaction rolls the registration back.
      throw result.error;
    }
  };
}

/**
 * Insert an aggregator with up to {@link SLUG_RETRIES} attempts. The
 * 4-hex-char random suffix on `slugFromName` makes collisions astronomically
 * unlikely, but retrying on `DUPLICATE_SLUG` makes the path robust against
 * the (also vanishingly rare) random-suffix collision.
 */
async function createAggregatorWithSlug(
  store: ReturnType<typeof getAggregatorStore>,
  name: string,
  extras: {
    type: ReturnType<typeof RegistrationPayloadSchema.parse>['type'];
    contact: BecknContact;
    consent: ReturnType<typeof RegistrationPayloadSchema.parse>['consent'];
    /** Writes the consent ledger row inside the create transaction. */
    recordConsent: RecordConsentHook;
    /** The coordinator's org (`users.org_id`). */
    orgId: string;
    /** The coordinator's own org details (Default-org registrations only). */
    legacyOrgDetails: LegacyOrgDetails | null;
    /** The consumed invite (#701; `registration_invites.jti`), when registered via one. */
    inviteId: string | null;
    profile: Record<string, unknown>;
    /** `null` when no registration schema resolved — variant unknown. */
    profileRef: string | null;
  },
): ReturnType<typeof store.create> {
  let last: Awaited<ReturnType<typeof store.create>> | null = null;
  for (let attempt = 0; attempt < SLUG_RETRIES; attempt += 1) {
    const orgSlug = slugFromName(name);
    last = await store.create({
      orgSlug,
      name,
      type: extras.type,
      contact: extras.contact,
      consent: extras.consent,
      recordConsent: extras.recordConsent,
      createdBy: 'self',
      updatedBy: 'self',
      orgId: extras.orgId,
      legacyOrgDetails: extras.legacyOrgDetails,
      inviteId: extras.inviteId,
      profile: extras.profile,
      profileRef: extras.profileRef,
    });
    if (last.ok) return last;
    if (last.error.code !== 'DUPLICATE_SLUG') return last;
  }
  return (
    last ?? {
      ok: false,
      error: { code: 'DB_UNAVAILABLE', message: 'slug retries exhausted' },
    }
  );
}

function mapStoreCreateError(
  code:
    | 'NOT_FOUND'
    | 'DUPLICATE_SLUG'
    | 'DUPLICATE_PHONE'
    | 'DUPLICATE_EMAIL'
    | 'DUPLICATE'
    | 'CHECK_VIOLATION'
    | 'CONSENT_WRITE_FAILED'
    | 'DB_UNAVAILABLE',
): ErrorCode {
  switch (code) {
    case 'DUPLICATE_SLUG':
      return 'DUPLICATE_SLUG';
    // The ledger write failed inside the create transaction: nothing exists.
    case 'CONSENT_WRITE_FAILED':
      return 'CONSENT_WRITE_FAILED';
    // An unrecognised unique violation is a real conflict, but not one this
    // layer can name — don't dress it up as a taken slug (#718 review).
    case 'DUPLICATE':
      return 'CONFLICT';
    case 'DUPLICATE_PHONE':
      return 'PHONE_EXISTS';
    case 'DUPLICATE_EMAIL':
      return 'USER_EXISTS';
    case 'CHECK_VIOLATION':
      return 'SCHEMA_VALIDATION';
    default:
      return 'DB_UNAVAILABLE';
  }
}

/**
 * Resolves the approval-email routing for a coordinator. The approve/reject
 * tokens always carry the coordinator's `org` claim (spec §6.2 / §9; the
 * Default org included, D3-6). The review email goes to the org's owner; for
 * the Default org, to `DEFAULT_ORG_OWNER_EMAIL` when configured, otherwise to
 * the network-admin list (empty `recipientEmail`), as flat instances did.
 *
 * @param parentOrgId - The coordinator's org id (`null` only for a pre-0028 row).
 * @returns `{ org?, recipientEmail? }` extras for `sendAdminReviewEmail`.
 */
async function resolveOwnerRouting(
  parentOrgId: string | null,
): Promise<{ org?: string; recipientEmail?: string }> {
  if (!parentOrgId) return {};
  const org = await getAggregatorOrgStore().findById(parentOrgId);
  if (org.ok && org.value?.isDefault) {
    const owner = defaultOrgOwnerEmail();
    return { org: parentOrgId, ...(owner ? { recipientEmail: owner } : {}) };
  }
  const ownerEmail = org.ok && org.value ? org.value.ownerEmail : undefined;
  return { org: parentOrgId, ...(ownerEmail ? { recipientEmail: ownerEmail } : {}) };
}

/**
 * Whether a submitted Beckn location carries anything real: a street or
 * locality, or coordinates other than the web form's `[0,0]` placeholder.
 *
 * @param loc - One submitted location.
 * @returns `true` when it is worth keeping.
 */
function hasLocationContent(loc: BecknLocation): boolean {
  const a = loc.address;
  if (a?.streetAddress?.trim() || a?.addressLocality?.trim()) return true;
  const c = (loc.geo as { coordinates?: unknown }).coordinates;
  return Array.isArray(c) && c.length === 2 && (c[0] !== 0 || c[1] !== 0);
}
