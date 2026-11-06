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
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RegistrationPayloadSchema } from '@aggregator-dpg/shared-primitives/aggregator';
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
import { errorMessage } from '@aggregator-dpg/shared-primitives/errors';
import { assertServiceCaller, assertSubmitRate } from './registration-shared.js';

const SLUG_RETRIES = 3;

// Adds `org_id` and `invite` to the strict payload schema.
const CoordinatorRegistrationBodySchema = RegistrationPayloadSchema.extend({
  org_id: z.string().optional(),
  // Invite token. When present it replaces `org_id` and is consumed on submit.
  invite: z.string().optional(),
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

export async function registerAggregatorRegistrationRoutes(base: FastifyInstance): Promise<void> {
  const app = base.withTypeProvider<ZodTypeProvider>();
  app.post(
    '/v1/aggregator-registrations/create',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-registrations'],
        summary: 'Submit a new aggregator registration',
        description:
          'Validates submission against config/schemas/aggregator/registration.v1.json, creates a disabled user (login enabled on admin approval), and pushes the org to signalstack. Reached via a non-aggregator Bearer token from Keycloak. 200 instead of 201 when a pending registration is submitted again: a fresh approval link is sent.',
        body: CoordinatorRegistrationBodySchema,
        response: {
          200: RegistrationCreatedResponseSchema,
          201: RegistrationCreatedResponseSchema,
          ...errorResponses(400, 401, 409, 500, 503),
        },
      },
    },
    async (req, reply) => {
      const log = req.log.child({ operation: 'aggregator-registration.create' });
      const start = Date.now();

      // Invite claimed by this request, before anything is created. Unless the
      // registration completes, the `finally` below gives it back.
      let inviteJti: string | null = null;
      let inviteCommitted = false;
      try {
        // The BFF calls this with a service-account token, so no
        // `aggregator_id` claim is required.
        await assertServiceCaller(req);
        // Already validated and parsed by the route schema.
        const body = req.body;
        const { contact, phoneE164, serverConsent } = await checkCoordinatorBody(body);
        // Fails open so a Redis outage does not block registration.
        await assertSubmitRate(`${req.ip}|${contact.email}`, reply);

        const target = body.invite
          ? await claimInvitedOrg(body.invite, contact.email)
          : await selectedOrg(body.org_id, contact.email);
        inviteJti = target.inviteJti;
        const legacyOrgDetails = ownOrgDetails(body, target.isDefault);

        const userStore = getUserStore();
        const resubmitted = await findResubmission(userStore, contact.email, phoneE164);
        if (resubmitted) return reclaimReview(resubmitted, reply, log, start);
        await assertNotInIdp(contact.email, phoneE164);

        // Consent is written in the same transaction as the coordinator row,
        // before any Keycloak call. No coordinator exists without a consent record.
        const recordConsent = await aggregatorConsentWriter({
          consent: serverConsent,
          log,
        });

        const aggregator = await createAggregatorWithSlug(userStore, body.name, {
          type: body.type,
          contact,
          consent: serverConsent,
          recordConsent,
          orgId: target.orgId,
          legacyOrgDetails,
          inviteId: inviteJti,
          profile: buildAggregatorProfile(body),
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
        const keycloakUserId = await createCoordinatorLogin(
          userStore,
          aggregatorId,
          body.type,
          contact,
        );

        // Fully provisioned: keep the invite consumed.
        inviteCommitted = true;

        await sendAdminReviewEmail(
          {
            aggregatorId,
            applicantName: body.name,
            applicantEmail: contact.email,
            applicantPhone: phoneE164,
            ...(target.inviteEmail ? { invitedEmail: target.inviteEmail } : {}),
            ...(await resolveOwnerRouting(target.orgId)),
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
        // Give the invite back on any exit that did not create a registration.
        // Only releases the claim this request took.
        if (inviteJti && !inviteCommitted) await releaseInvite(inviteJti, log);
      }
    },
  );
}

type Log = ReturnType<FastifyRequest['log']['child']>;
type CoordinatorBody = z.infer<typeof CoordinatorRegistrationBodySchema>;
type UserStore = ReturnType<typeof getUserStore>;
type OrgStore = ReturnType<typeof getOrganisationStore>;

/** The org a coordinator registers under, and the invite claimed for it. */
interface TargetOrg {
  orgId: string;
  isDefault: boolean;
  // The invited email. The coordinator may register with another one; this is
  // kept so the approving owner can see it.
  inviteEmail: string | null;
  inviteJti: string | null;
}

/**
 * Checks the body against the network and the registration schema.
 *
 * @returns The contact with its E.164 phone, and the server-stamped consent.
 * @throws {HttpError} SCHEMA_VALIDATION or INVALID_PHONE
 */
async function checkCoordinatorBody(body: CoordinatorBody) {
  // `type` must be one of the network's domain ids.
  const networkCfg = await getNetworkConfig();
  if (!networkCfg.domainIds.includes(body.type)) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: `unknown type '${body.type}' — valid: ${networkCfg.domainIds.join(', ')}`,
      fields: { type: 'invalid' },
    });
  }

  // `org_id` and `invite` are not form fields; strip them before Ajv.
  const { org_id: _orgIdField, invite: _inviteField, ...formBody } = body;
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
      // Keyed `phone` so the logger redacts it.
      fields: { phone: body.contact.phone },
    });
  }
  const phoneE164 = phoneResult.value;
  // Store the E.164 phone. Zod has already lowercased the email.
  const contact: BecknContact = { ...body.contact, phone: phoneE164 };

  // Stamp consent with the server time. `valid_till` is clamped to a maximum.
  const serverConsent = stampConsent(body.consent);
  if (!serverConsent) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'consent.valid_till must be in the future.',
      fields: { 'consent.valid_till': 'invalid' },
    });
  }
  return { contact, phoneE164, serverConsent };
}

/**
 * Reads an org by id.
 *
 * @throws {HttpError} DB_UNAVAILABLE
 */
async function findOrg(orgStore: OrgStore, id: string) {
  const org = await orgStore.findById(id);
  if (!org.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(org.error.message),
      fields: { sub_operation: 'orgStore.findById' },
    });
  }
  return org.value;
}

/**
 * An org owner cannot also register as a coordinator.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED
 */
async function assertNotOrgOwner(orgStore: OrgStore, email: string): Promise<void> {
  const ownerMatch = await orgStore.findByOwnerEmail(email);
  if (ownerMatch.ok && ownerMatch.value) {
    throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email } });
  }
}

/**
 * Invite path: the org comes from the token claim, re-checked against the
 * database, and the invite is claimed before anything is created, so
 * concurrent submits on one link create at most one registration.
 *
 * @throws {HttpError} INVITE_EXPIRED, INVITE_INVALID, TARGET_ORG_INACTIVE,
 *   OWNER_ALREADY_REGISTERED, INVITE_ALREADY_USED or DB_UNAVAILABLE
 */
async function claimInvitedOrg(invite: string, email: string): Promise<TargetOrg> {
  const verified = await verifyInviteToken(invite);
  if (!verified.ok) {
    throw httpError(verified.error.code === 'EXPIRED' ? 'INVITE_EXPIRED' : 'INVITE_INVALID');
  }
  const orgStore = getOrganisationStore();
  const org = await findOrg(orgStore, verified.org);
  // The Default org takes no invites.
  if (org?.status !== 'active' || org.isDefault) {
    throw httpError('TARGET_ORG_INACTIVE');
  }
  await assertNotOrgOwner(orgStore, email);
  const claimed = await getRegistrationInvitesStore().consume(verified.jti);
  if (!claimed.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(claimed.error.message),
      fields: { sub_operation: 'inviteStore.consume' },
    });
  }
  if (claimed.value === null) {
    throw httpError('INVITE_ALREADY_USED', { fields: { email } });
  }
  return {
    orgId: verified.org,
    isDefault: false,
    // The invited email is recorded, not enforced.
    inviteEmail: verified.email.trim().toLowerCase(),
    inviteJti: verified.jti,
  };
}

/**
 * Selector path: the coordinator picks an active org. `org_id` is required.
 *
 * @throws {HttpError} SCHEMA_VALIDATION, TARGET_ORG_INACTIVE,
 *   OWNER_ALREADY_REGISTERED or DB_UNAVAILABLE
 */
async function selectedOrg(orgId: string | undefined, email: string): Promise<TargetOrg> {
  if (!orgId) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'org_id is required.',
      fields: { field: 'org_id' },
    });
  }
  const orgStore = getOrganisationStore();
  const org = await findOrg(orgStore, orgId);
  if (org?.status !== 'active') {
    throw httpError('TARGET_ORG_INACTIVE');
  }
  await assertNotOrgOwner(orgStore, email);
  if (org.isDefault) await assertDefaultSelectable(orgStore);
  return { orgId: org.id, isDefault: org.isDefault, inviteEmail: null, inviteJti: null };
}

/**
 * The Default org is selectable only while it is the only active org.
 *
 * @throws {HttpError} TARGET_ORG_INACTIVE or DB_UNAVAILABLE
 */
async function assertDefaultSelectable(orgStore: OrgStore): Promise<void> {
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

/**
 * The coordinator's own org details, kept only for a Default-org coordinator.
 *
 * `url` and `locations` belong to a real org, so sending them is refused. A
 * Default-org coordinator keeps its own as `legacy_org_details`, and names its
 * own organisation, never "Default".
 *
 * @returns The details to store, or null.
 * @throws {HttpError} SCHEMA_VALIDATION or ORG_DETAILS_READ_ONLY
 */
function ownOrgDetails(body: CoordinatorBody, isDefault: boolean): LegacyOrgDetails | null {
  if (isDefault && body.name.trim().toLowerCase() === 'default') {
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
  if (!isDefault) {
    throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: sent } });
  }
  return details;
}

/**
 * The existing registration this submit repeats, if any.
 *
 * A pending one is returned as is. A rejected one is set back to pending once
 * its cooling window has passed. Any other owner of the email or phone refuses
 * the submit.
 *
 * @returns The registration to re-send the review link for, or null.
 * @throws {HttpError} REGISTRATION_COOLING, USER_EXISTS, PHONE_EXISTS or DB_UNAVAILABLE
 */
async function findResubmission(
  userStore: UserStore,
  email: string,
  phoneE164: string,
): Promise<Coordinator | null> {
  const byEmail = await userStore.findByContactEmail(email);
  if (!byEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (byEmail.value !== null) {
    const existing = byEmail.value;
    if (existing.status === 'inactive') return reviveRejected(userStore, existing, { email });
    // Active or retired: the email is taken.
    if (existing.status !== 'pending') throw httpError('USER_EXISTS', { fields: { email } });
    return existing;
  }

  const byPhone = await userStore.findByContactPhone(phoneE164);
  if (!byPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (byPhone.value === null) return null;
  if (byPhone.value.status === 'inactive') {
    return reviveRejected(userStore, byPhone.value, { phone: phoneE164 });
  }
  throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
}

/**
 * Sets a rejected registration back to pending, refusing it until the cooling
 * window from `rejected_at` ends.
 *
 * @param contactField - The matched email or phone, echoed in the cooling error.
 * @returns The registration as read.
 * @throws {HttpError} REGISTRATION_COOLING or DB_UNAVAILABLE
 */
async function reviveRejected(
  userStore: UserStore,
  row: Coordinator,
  contactField: Readonly<Record<string, string>>,
): Promise<Coordinator> {
  const retryAfter = coolingRetryAfter(row.rejectedAt, row.updatedAt);
  if (retryAfter) {
    throw httpError('REGISTRATION_COOLING', {
      fields: { ...contactField, retry_after: retryAfter },
    });
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
 * The email and phone must be free in Keycloak too; the phone is the OTP login key.
 *
 * @throws {HttpError} USER_EXISTS, PHONE_EXISTS or IDP_UNAVAILABLE
 */
async function assertNotInIdp(email: string, phoneE164: string): Promise<void> {
  const idp = getIdpAdmin();
  const kcEmail = await idp.findByEmail(email);
  if (!kcEmail.ok) {
    throw httpError('IDP_UNAVAILABLE', {
      cause: kcEmail.error,
      fields: { sub_operation: 'idp.findByEmail' },
    });
  }
  if (kcEmail.value !== null) {
    throw httpError('USER_EXISTS', { fields: { email } });
  }
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
}

/**
 * Creates the coordinator's disabled Keycloak user. On failure the new
 * coordinator row is deleted.
 *
 * Keycloak attributes: `aggregator_id` (the row id), `aggregator_type`
 * (participant focus), `phoneNumber` (OTP login key), `decision_made` (login gate).
 *
 * @returns The Keycloak user id.
 * @throws {HttpError} USER_EXISTS, NAME_INVALID_CHARACTERS or IDP_UNAVAILABLE
 */
async function createCoordinatorLogin(
  userStore: UserStore,
  aggregatorId: string,
  type: string,
  contact: BecknContact,
): Promise<string> {
  const { firstName, lastName } = splitName(contact.name);
  const kcResult = await getIdpAdmin().createUser({
    email: contact.email,
    username: contact.email,
    phone: contact.phone,
    enabled: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.AGGREGATOR_ID]: aggregatorId,
      [KC_ATTR.AGGREGATOR_TYPE]: type,
      [KC_ATTR.PHONE_NUMBER]: contact.phone,
      [KC_ATTR.DECISION_MADE]: 'pending',
    },
  });
  if (kcResult.ok) return kcResult.value.id;
  await userStore.deleteById(aggregatorId);
  if (kcResult.error.code === 'USER_EXISTS') {
    throw httpError('USER_EXISTS', {
      cause: kcResult.error,
      fields: { email: contact.email, rolled_back: true },
    });
  }
  if (kcResult.error.code === 'INVALID_NAME') {
    throw httpError('NAME_INVALID_CHARACTERS', {
      fields: { name: 'contact.name', rolled_back: true },
    });
  }
  throw httpError('IDP_UNAVAILABLE', {
    cause: kcResult.error,
    fields: { sub_operation: 'idp.createUser', rolled_back: true },
  });
}

/**
 * Re-sends the review link for an existing pending or revived record using
 * stored values. The anonymous submit never changes the record: it carries no
 * proof of identity, so a stranger must not overwrite it.
 */
async function reclaimReview(
  row: Coordinator,
  reply: FastifyReply,
  log: Log,
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
    {
      status: 'success',
      latency_ms: Date.now() - start,
      aggregator_id: row.id,
      reclaim: true,
    },
    'registration re-submitted — review link re-sent (no field change)',
  );
  // Consent is recorded only on a fresh registration, not here.
  return reply.status(200).send({
    aggregator_id: row.id,
    org_slug: row.orgSlug,
    status: 'pending',
    message: 'Registration re-submitted. A fresh approval link has been sent for review.',
  });
}

/** Gives back an invite claimed by a registration that did not complete. */
async function releaseInvite(inviteJti: string, log: Log): Promise<void> {
  const released = await getRegistrationInvitesStore().release(inviteJti);
  if (!released.ok || released.value === null) {
    log.warn(
      { status: 'failure', sub_operation: 'inviteStore.release', invite_jti: inviteJti },
      'invite release after an incomplete registration did not commit',
    );
  }
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
        error: errorMessage(e),
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
  const c = loc.geo.coordinates;
  return Array.isArray(c) && c.length === 2 && (c[0] !== 0 || c[1] !== 0);
}
