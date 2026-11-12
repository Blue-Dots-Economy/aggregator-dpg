/**
 * Coordinator registration endpoints in `@aggregator-dpg/api`.
 *
 * Public submission flow:
 *   1. Validate the body with Zod and with `registration.v1.json` (Ajv). The
 *      JSON Schema is the form contract.
 *   2. Normalise `contact.phone` to E.164.
 *   3. Check email and phone uniqueness in the database and Keycloak.
 *   4. Generate `org_slug` from the name, retrying on a collision.
 *   5. Insert the coordinator (`pending`) and its consent row in one
 *      transaction. Extra schema fields go into `profile`.
 *   6. Create a disabled Keycloak user with `aggregator_id`,
 *      `aggregator_type`, `phoneNumber` and `decision_made: 'pending'`.
 *      Approval enables it.
 *   7. Email the review link to the org owner (see `resolveOwnerRouting`).
 *
 * A consent-ledger failure rolls the insert back. A Keycloak failure after the
 * commit deletes the coordinator row; its consent row stays, unlinked.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
import {
  InviteReadQuerySchema,
  InviteReadResponseSchema,
} from '@aggregator-dpg/shared-primitives/user-org';
import {
  authenticateCaller,
  claimInvite,
  inviteReadHandler,
  releaseInvite,
  usableInvite,
} from './invite-shared.js';
import type { BecknContact, BecknLocation } from '@aggregator-dpg/shared-primitives/aggregator';
import { getRegistrationValidator } from '../services/registration-validator.js';
import { getUserStore } from '../services/user-store/index.js';
import { stampConsent } from '../services/registration-consent.js';
import type {
  Coordinator,
  LegacyOrgDetails,
  RecordConsentHook,
} from '../services/user-store/interface.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
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
import { getNetworkConfig } from '../services/network-config.js';
import { resolveProfileRef } from '../services/schema-ref.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { slugFromName } from '../services/slug.js';
import { KC_ATTR } from '../services/idp-admin/index.js';
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import type { ErrorCode } from '../errors/codes.js';

const SLUG_RETRIES = 3;

// Adds `org_id` and `invite` to the strict payload schema.
const CoordinatorRegistrationBodySchema = RegistrationPayloadSchema.extend({
  org_id: z.string().optional(),
  // Invite token. When present it replaces `org_id` and is consumed on submit.
  invite: z.string().optional(),
});

const CoordinatorInviteAcceptBodySchema = RegistrationPayloadSchema.extend({
  invite: z.string().min(1).max(4096),
});

/** `201` of an invite accept: the account is pending until the email code is entered. */
const InviteAcceptedResponseSchema = z.object({
  aggregator_id: z.string(),
  org_slug: z.string(),
  status: z.literal('pending'),
  message: z.string(),
  /** The invited email, passed to the sign-in page so the invitee is not asked for it. */
  login_hint: z.string(),
});

/**
 * Body keys stored elsewhere, so never copied into `profile`.
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
 * Collects the schema-driven fields of a registration body into the `profile` payload.
 *
 * The JSON Schema (`additionalProperties: false`) bounds which keys can appear.
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
      config: { rbac: { access: 'service' } },
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
      await authenticateCaller(req);
      const body = req.body as z.infer<typeof CoordinatorRegistrationBodySchema>;
      const { org_id: _orgIdField, invite: _inviteField, ...formBody } = body;
      const { contact, phoneE164, consent } = await checkCoordinatorSubmission(
        req,
        reply,
        body,
        formBody,
      );
      const userStore = getUserStore();

      // Invite claimed by this request, before anything is created. Unless the
      // registration completes, the `finally` below gives it back.
      const claim: InviteClaim = { jti: null };
      let committed = false;
      try {
        const target = await selfRegistrationOrg(body, contact.email, claim);
        const ownOrgDetails = selfRegistrationOrgDetails(body, target.orgIsDefault);
        const existing = await reclaimableRegistration(userStore, contact.email, phoneE164);
        if (existing) return reclaimReview(reply, existing, log, start);
        const idp = getIdpAdmin();
        await assertNotInKeycloak(idp, contact.email, phoneE164);

        const { aggregatorId, orgSlug } = await createCoordinatorRow(userStore, body, {
          contact,
          consent,
          orgId: target.parentOrgId,
          legacyOrgDetails: ownOrgDetails,
          inviteId: claim.jti,
          log,
        });
        const keycloakUserId = await createCoordinatorLogin(userStore, idp, {
          aggregatorId,
          type: body.type,
          contact,
          invited: false,
        });
        committed = true;

        await sendAdminReviewEmail(
          {
            aggregatorId,
            applicantName: body.name,
            applicantEmail: contact.email,
            applicantPhone: phoneE164,
            ...(target.inviteEmail ? { invitedEmail: target.inviteEmail } : {}),
            ...(await resolveOwnerRouting(target.parentOrgId)),
          },
          log,
        );
        log.info(
          {
            status: 'success',
            latency_ms: Date.now() - start,
            aggregator_id: aggregatorId,
            org_slug: orgSlug,
            keycloak_user_id: keycloakUserId,
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
        if (claim.jti && !committed) await releaseInvite(claim.jti, log);
      }
    },
  );

  app.post(
    '/v1/user/invite/accept',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Register a coordinator from an invite',
        description:
          'Creates the invited coordinator as `pending` with a Keycloak user that can sign in but holds no access yet. The email must be the invited address. The account becomes active when the invitee signs in with an email code and calls `POST /v1/user/activate`; no owner approval. Reached with the web BFF service-account token.',
        body: CoordinatorInviteAcceptBodySchema,
        response: {
          201: InviteAcceptedResponseSchema,
          ...errorResponses(400, 401, 409, 410, 500, 503),
        },
      },
    },
    acceptCoordinatorInvite,
  );

  app.get(
    '/v1/user/invite/read',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Read a coordinator invite for its registration page',
        description:
          'Checks the invite link without using it up and returns the invited email and the org it is for. Reached with the web BFF service-account token.',
        querystring: InviteReadQuerySchema,
        response: {
          200: InviteReadResponseSchema,
          ...errorResponses(400, 401, 409, 410, 503),
        },
      },
    },
    inviteReadHandler('coordinator'),
  );
}

/** A checked coordinator form: its contact with the E.164 phone, and the server-stamped consent. */
interface CoordinatorSubmission {
  contact: BecknContact;
  phoneE164: string;
  consent: RegistrationPayload['consent'];
}

type RegistrationPayload = z.infer<typeof RegistrationPayloadSchema>;
type RequestLog = ReturnType<FastifyRequest['log']['child']>;

/**
 * Checks a coordinator form, normalises its phone, stamps its consent and applies the submit rate limit.
 *
 * @param body - The parsed payload.
 * @param formBody - The form fields only, validated against the registration JSON Schema.
 * @throws {HttpError} SCHEMA_VALIDATION, INVALID_PHONE or RATE_LIMITED.
 */
async function checkCoordinatorSubmission(
  req: FastifyRequest,
  reply: FastifyReply,
  body: RegistrationPayload,
  formBody: Record<string, unknown>,
): Promise<CoordinatorSubmission> {
  const networkCfg = await getNetworkConfig();
  if (!networkCfg.domainIds.includes(body.type)) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: `unknown type '${body.type}' — valid: ${networkCfg.domainIds.join(', ')}`,
      fields: { type: 'invalid' },
    });
  }
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
      fields: { phone: body.contact.phone },
    });
  }
  const phoneE164 = phoneResult.value;
  const contact: BecknContact = { ...body.contact, phone: phoneE164 };

  const consent = stampConsent(body.consent);
  if (!consent) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'consent.valid_till must be in the future.',
      fields: { 'consent.valid_till': 'invalid' },
    });
  }

  const rl = await checkSubmitRate(`${req.ip}|${contact.email}`);
  if (!rl.allowed) {
    void reply.header('Retry-After', String(rl.retryAfterSeconds));
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${rl.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: rl.retryAfterSeconds },
    });
  }
  return { contact, phoneE164, consent };
}

/** The invite a public submit claimed, so an incomplete registration can give it back. */
interface InviteClaim {
  jti: string | null;
}

/** The org a public submit registers under, and the email its invite was sent to. */
interface SelfRegistrationTarget {
  parentOrgId: string;
  orgIsDefault: boolean;
  /** Recorded for the approving owner; the coordinator may register with another email. */
  inviteEmail: string | null;
}

/**
 * Resolves the org of a public submit: from its invite, or the org picked on the form.
 *
 * @throws {HttpError} On an unusable invite or org.
 */
async function selfRegistrationOrg(
  body: z.infer<typeof CoordinatorRegistrationBodySchema>,
  email: string,
  claim: InviteClaim,
): Promise<SelfRegistrationTarget> {
  if (body.invite) return invitedOrg(body.invite, email, claim);
  return selectedOrg(body.org_id, email);
}

/**
 * Checks a public submit's invite and claims it before anything is created.
 *
 * @throws {HttpError} INVITE_INVALID, INVITE_EXPIRED, INVITE_ALREADY_USED, TARGET_ORG_INACTIVE,
 *   OWNER_ALREADY_REGISTERED or DB_UNAVAILABLE.
 */
async function invitedOrg(
  token: string,
  email: string,
  claim: InviteClaim,
): Promise<SelfRegistrationTarget> {
  const verified = await verifyInviteToken(token);
  if (!verified.ok) {
    throw httpError(verified.error.code === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_INVALID');
  }
  if (verified.role !== 'coordinator') throw httpError('INVITE_INVALID');
  const org = await getOrganisationStore().findById(verified.org);
  if (!org.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(org.error.message),
      fields: { sub_operation: 'orgStore.findById' },
    });
  }
  if (org.value?.status !== 'active' || org.value.isDefault) {
    throw httpError('TARGET_ORG_INACTIVE');
  }
  await assertNotOrgOwner(email);
  const claimed = await getRegistrationInvitesStore().consume(verified.jti);
  if (!claimed.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(claimed.error.message),
      fields: { sub_operation: 'inviteStore.consume' },
    });
  }
  if (claimed.value === null) throw httpError('INVITE_ALREADY_USED', { fields: { email } });
  claim.jti = verified.jti;
  return {
    parentOrgId: verified.org,
    orgIsDefault: false,
    inviteEmail: verified.email.trim().toLowerCase(),
  };
}

/**
 * Checks the org picked on the public form; the Default org only while it is the only active org.
 *
 * @throws {HttpError} SCHEMA_VALIDATION, TARGET_ORG_INACTIVE, OWNER_ALREADY_REGISTERED or DB_UNAVAILABLE.
 */
async function selectedOrg(
  orgId: string | undefined,
  email: string,
): Promise<SelfRegistrationTarget> {
  if (!orgId) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'org_id is required.',
      fields: { field: 'org_id' },
    });
  }
  const orgStore = getOrganisationStore();
  const org = await orgStore.findById(orgId);
  if (!org.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(org.error.message),
      fields: { sub_operation: 'orgStore.findById' },
    });
  }
  if (org.value?.status !== 'active') throw httpError('TARGET_ORG_INACTIVE');
  await assertNotOrgOwner(email);
  if (org.value.isDefault) {
    const active = await orgStore.listActive();
    if (!active.ok) {
      throw httpError('DB_UNAVAILABLE', {
        cause: new Error(active.error.message),
        fields: { sub_operation: 'orgStore.listActive' },
      });
    }
    if (active.value.some((o) => !o.isDefault)) throw httpError('TARGET_ORG_INACTIVE');
  }
  return { parentOrgId: org.value.id, orgIsDefault: org.value.isDefault, inviteEmail: null };
}

/**
 * Checks the org details a public submit sends: refused for a real org, kept for a Default-org coordinator.
 *
 * @returns The details to keep as `legacy_org_details`, or `null`.
 * @throws {HttpError} SCHEMA_VALIDATION or ORG_DETAILS_READ_ONLY.
 */
function selfRegistrationOrgDetails(
  body: RegistrationPayload,
  orgIsDefault: boolean,
): LegacyOrgDetails | null {
  if (orgIsDefault && body.name.trim().toLowerCase() === 'default') {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'The organisation name cannot be "Default".',
      fields: { field: 'name' },
    });
  }
  const submittedLocations = (body.locations ?? []).filter(hasLocationContent);
  const details: LegacyOrgDetails = {
    ...(body.url?.trim() ? { url: body.url.trim() } : {}),
    ...(submittedLocations.length > 0 ? { locations: submittedLocations } : {}),
  };
  const sent = Object.keys(details);
  if (sent.length === 0) return null;
  if (!orgIsDefault) throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: sent } });
  return details;
}

/**
 * Finds a registration a public submit re-sends the review link for, reviving a rejected one.
 *
 * The submit carries no proof of identity, so the stored record is never changed beyond its status.
 *
 * @returns The pending or revived registration, or `null` when the email and phone are free.
 * @throws {HttpError} USER_EXISTS, PHONE_EXISTS, REGISTRATION_COOLING or DB_UNAVAILABLE.
 */
async function reclaimableRegistration(
  userStore: ReturnType<typeof getUserStore>,
  email: string,
  phoneE164: string,
): Promise<Coordinator | null> {
  const dbEmail = await userStore.findByContactEmail(email);
  if (!dbEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(dbEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  const byEmail = dbEmail.value;
  if (byEmail?.status === 'inactive') return reviveRejected(userStore, byEmail, { email });
  if (byEmail?.status === 'pending') return byEmail;
  if (byEmail) throw httpError('USER_EXISTS', { fields: { email } });

  const dbPhone = await userStore.findByContactPhone(phoneE164);
  if (!dbPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(dbPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  const byPhone = dbPhone.value;
  if (byPhone?.status === 'inactive') {
    return reviveRejected(userStore, byPhone, { phone: phoneE164 });
  }
  if (byPhone) throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
  return null;
}

/**
 * Sets a rejected registration back to pending once its cooling window from `rejected_at` has ended.
 *
 * @param field - The submitted email or phone that matched, named in a refusal.
 * @throws {HttpError} REGISTRATION_COOLING or DB_UNAVAILABLE.
 */
async function reviveRejected(
  userStore: ReturnType<typeof getUserStore>,
  row: Coordinator,
  field: { email: string } | { phone: string },
): Promise<Coordinator> {
  const retryAfter = coolingRetryAfter(row.rejectedAt, row.updatedAt);
  if (retryAfter) {
    throw httpError('REGISTRATION_COOLING', { fields: { ...field, retry_after: retryAfter } });
  }
  const revived = await userStore.update(row.id, {
    status: 'pending',
    rejectedAt: null,
    updatedBy: 'self',
  });
  if (!revived.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(revived.error.message),
      fields: { sub_operation: 'userStore.reviveRejected' },
    });
  }
  return row;
}

/**
 * Re-sends the review link for a pending or revived registration, from its stored values.
 *
 * Consent is recorded only on a fresh registration, not here.
 */
async function reclaimReview(
  reply: FastifyReply,
  row: Coordinator,
  log: RequestLog,
  start: number,
): Promise<FastifyReply> {
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
    { status: 'success', latency_ms: Date.now() - start, aggregator_id: row.id, reclaim: true },
    'registration re-submitted — review link re-sent (no field change)',
  );
  return reply.status(200).send({
    aggregator_id: row.id,
    org_slug: row.orgSlug,
    status: 'pending',
    message: 'Registration re-submitted. A fresh approval link has been sent for review.',
  });
}

/**
 * Registers a coordinator from an invite.
 *
 * The email must be the invited one. The coordinator is created `pending`
 * with a Keycloak user that is enabled, unverified and `decision_made = invited`;
 * it is activated by `POST /v1/user/activate` after an email sign-in. The
 * invite is claimed before anything is created and given back if the
 * registration does not complete.
 *
 * @throws {HttpError} On any refusal; the error code names the reason.
 */
async function acceptCoordinatorInvite(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const log = req.log.child({ operation: 'invite.user.accept' });
  const start = Date.now();
  await authenticateCaller(req);

  const { invite: token, ...body } = req.body as z.infer<typeof CoordinatorInviteAcceptBodySchema>;
  const { contact, phoneE164, consent } = await checkCoordinatorSubmission(req, reply, body, body);
  const invite = await usableInvite(token, 'coordinator');
  if (contact.email !== invite.email) throw httpError('INVITE_EMAIL_MISMATCH');
  await assertNotOrgOwner(contact.email);
  assertNoOrgDetails(body);

  const userStore = getUserStore();
  const idp = getIdpAdmin();
  await assertContactFree(userStore, idp, contact.email, phoneE164);

  await claimInvite(invite.jti);
  let committed = false;
  try {
    const { aggregatorId, orgSlug } = await createCoordinatorRow(userStore, body, {
      contact,
      consent,
      orgId: invite.org.id,
      legacyOrgDetails: null,
      inviteId: invite.jti,
      log,
    });
    const keycloakUserId = await createCoordinatorLogin(userStore, idp, {
      aggregatorId,
      type: body.type,
      contact,
      invited: true,
    });
    committed = true;
    log.info(
      {
        status: 'success',
        latency_ms: Date.now() - start,
        aggregator_id: aggregatorId,
        org_slug: orgSlug,
        keycloak_user_id: keycloakUserId,
      },
      'invited coordinator registered; awaiting email verification',
    );
    return reply.status(201).send({
      aggregator_id: aggregatorId,
      org_slug: orgSlug,
      status: 'pending',
      message: 'Registration received. Sign in with the code we email you to finish.',
      login_hint: contact.email,
    });
  } finally {
    if (!committed) await releaseInvite(invite.jti, log);
  }
}

/**
 * Refuses an email that already owns an organisation.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED.
 */
async function assertNotOrgOwner(email: string): Promise<void> {
  const ownerMatch = await getOrganisationStore().findByOwnerEmail(email);
  if (ownerMatch.ok && ownerMatch.value) {
    throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email } });
  }
}

/**
 * Refuses `url` and `locations`, which belong to the coordinator's org.
 *
 * @throws {HttpError} ORG_DETAILS_READ_ONLY.
 */
function assertNoOrgDetails(body: RegistrationPayload): void {
  const sent = [
    ...(body.url?.trim() ? ['url'] : []),
    ...((body.locations ?? []).some(hasLocationContent) ? ['locations'] : []),
  ];
  if (sent.length > 0) throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: sent } });
}

/**
 * Refuses an email or phone that already belongs to an account, in the database or Keycloak.
 *
 * @throws {HttpError} USER_EXISTS, PHONE_EXISTS, DB_UNAVAILABLE or IDP_UNAVAILABLE.
 */
async function assertContactFree(
  userStore: ReturnType<typeof getUserStore>,
  idp: ReturnType<typeof getIdpAdmin>,
  email: string,
  phoneE164: string,
): Promise<void> {
  const [dbEmail, dbPhone] = await Promise.all([
    userStore.findByContactEmail(email),
    userStore.findByContactPhone(phoneE164),
  ]);
  if (!dbEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(dbEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (dbEmail.value !== null) throw httpError('USER_EXISTS', { fields: { email } });
  if (!dbPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(dbPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (dbPhone.value !== null) throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
  await assertNotInKeycloak(idp, email, phoneE164);
}

/**
 * Refuses an email or phone that a Keycloak user already holds; the phone is the OTP login key.
 *
 * @throws {HttpError} USER_EXISTS, PHONE_EXISTS or IDP_UNAVAILABLE.
 */
async function assertNotInKeycloak(
  idp: ReturnType<typeof getIdpAdmin>,
  email: string,
  phoneE164: string,
): Promise<void> {
  const kcEmail = await idp.findByEmail(email);
  if (!kcEmail.ok) {
    throw httpError('IDP_UNAVAILABLE', {
      cause: kcEmail.error,
      fields: { sub_operation: 'idp.findByEmail' },
    });
  }
  if (kcEmail.value !== null) throw httpError('USER_EXISTS', { fields: { email } });
  const kcPhone = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164);
  if (!kcPhone.ok) {
    throw httpError('IDP_UNAVAILABLE', {
      cause: kcPhone.error,
      fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
    });
  }
  if (kcPhone.value !== null) throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
}

/**
 * Inserts the coordinator and its consent row in one transaction.
 *
 * @throws {HttpError} The mapped store error; CONSENT_WRITE_FAILED rolls the insert back.
 */
async function createCoordinatorRow(
  userStore: ReturnType<typeof getUserStore>,
  body: RegistrationPayload,
  row: {
    contact: BecknContact;
    consent: RegistrationPayload['consent'];
    orgId: string;
    legacyOrgDetails: LegacyOrgDetails | null;
    inviteId: string | null;
    log: RequestLog;
  },
): Promise<{ aggregatorId: string; orgSlug: string }> {
  const recordConsent = await aggregatorConsentWriter({ consent: row.consent, log: row.log });
  const created = await createAggregatorWithSlug(userStore, body.name, {
    type: body.type,
    contact: row.contact,
    consent: row.consent,
    recordConsent,
    orgId: row.orgId,
    legacyOrgDetails: row.legacyOrgDetails,
    inviteId: row.inviteId,
    profile: buildAggregatorProfile(body),
    profileRef: resolveProfileRef('registration.v1.json'),
  });
  if (!created.ok) {
    const code = mapStoreCreateError(created.error.code);
    throw httpError(code, {
      cause: new Error(created.error.message),
      ...(code === 'CONSENT_WRITE_FAILED'
        ? { fields: { sub_operation: 'recordAggregatorConsent', rolled_back: true } }
        : {}),
    });
  }
  return { aggregatorId: created.value.id, orgSlug: created.value.orgSlug };
}

/**
 * Creates the coordinator's Keycloak user; on failure deletes the coordinator row.
 *
 * A self-registered user is disabled until approval. An invited user is
 * enabled and unverified, and verifies by email code.
 *
 * @returns The Keycloak user id.
 * @throws {HttpError} USER_EXISTS, NAME_INVALID_CHARACTERS or IDP_UNAVAILABLE.
 */
async function createCoordinatorLogin(
  userStore: ReturnType<typeof getUserStore>,
  idp: ReturnType<typeof getIdpAdmin>,
  user: {
    aggregatorId: string;
    type: RegistrationPayload['type'];
    contact: BecknContact;
    invited: boolean;
  },
): Promise<string> {
  const { firstName, lastName } = splitName(user.contact.name);
  const created = await idp.createUser({
    email: user.contact.email,
    username: user.contact.email,
    phone: user.contact.phone,
    enabled: user.invited,
    emailVerified: !user.invited,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.AGGREGATOR_ID]: user.aggregatorId,
      [KC_ATTR.AGGREGATOR_TYPE]: user.type,
      [KC_ATTR.PHONE_NUMBER]: user.contact.phone,
      [KC_ATTR.DECISION_MADE]: user.invited ? 'invited' : 'pending',
    },
  });
  if (created.ok) return created.value.id;
  await userStore.deleteById(user.aggregatorId);
  if (created.error.code === 'USER_EXISTS') {
    throw httpError('USER_EXISTS', {
      cause: created.error,
      fields: { email: user.contact.email, rolled_back: true },
    });
  }
  if (created.error.code === 'INVALID_NAME') {
    throw httpError('NAME_INVALID_CHARACTERS', {
      fields: { name: 'contact.name', rolled_back: true },
    });
  }
  throw httpError('IDP_UNAVAILABLE', {
    cause: created.error,
    fields: { sub_operation: 'idp.createUser', rolled_back: true },
  });
}

/**
 * Builds the consent-ledger write that `store.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
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
 * Inserts a coordinator, retrying up to {@link SLUG_RETRIES} times on a slug collision.
 */
async function createAggregatorWithSlug(
  store: ReturnType<typeof getUserStore>,
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
    /** The consumed invite's `jti`, when registered via one. */
    inviteId: string | null;
    profile: Record<string, unknown>;
    /** `null` when no registration schema resolved. */
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
    // An unknown unique violation is a generic conflict.
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
 * Resolves the org claim and recipient for a coordinator's review email.
 *
 * The email goes to the org owner. For the Default org it goes to
 * `DEFAULT_ORG_OWNER_EMAIL`, else to the network admins (no `recipientEmail`).
 *
 * @param parentOrgId - The coordinator's org id, or `null`.
 * @returns `{ org?, recipientEmail? }` extras for `sendAdminReviewEmail`.
 */
async function resolveOwnerRouting(
  parentOrgId: string | null,
): Promise<{ org?: string; recipientEmail?: string }> {
  if (!parentOrgId) return {};
  const org = await getOrganisationStore().findById(parentOrgId);
  if (org.ok && org.value?.isDefault) {
    const owner = defaultOrgOwnerEmail();
    return { org: parentOrgId, ...(owner ? { recipientEmail: owner } : {}) };
  }
  const ownerEmail = org.ok && org.value ? org.value.ownerEmail : undefined;
  return { org: parentOrgId, ...(ownerEmail ? { recipientEmail: ownerEmail } : {}) };
}

/**
 * Reports whether a submitted location has a street, locality, or coordinates other than `[0,0]`.
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
