/**
 * Coordinator invite endpoints in `@aggregator-dpg/api`.
 *
 *   GET  /v1/user/invite/read     check an invite link for its registration page
 *   POST /v1/user/invite/accept   register the invited coordinator
 *
 * Accept validates the body with Zod and with `registration.v1.json` (Ajv),
 * normalises the phone to E.164, checks email and phone uniqueness in the
 * database and Keycloak, then inserts the coordinator (`pending`) and its
 * consent row in one transaction and creates its Keycloak user. Extra schema
 * fields go into `profile`.
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
import type { LegacyOrgDetails, RecordConsentHook } from '../services/user-store/interface.js';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import { getIdpAdmin } from '../services/idp-admin/index.js';
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

export async function registerAggregatorRegistrationRoutes(app: FastifyInstance): Promise<void> {
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
 * @param body - The parsed form, validated against the registration JSON Schema.
 * @throws {HttpError} SCHEMA_VALIDATION, INVALID_PHONE or RATE_LIMITED.
 */
async function checkCoordinatorSubmission(
  req: FastifyRequest,
  reply: FastifyReply,
  body: RegistrationPayload,
): Promise<CoordinatorSubmission> {
  const networkCfg = await getNetworkConfig();
  if (!networkCfg.domainIds.includes(body.type)) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: `unknown type '${body.type}' — valid: ${networkCfg.domainIds.join(', ')}`,
      fields: { type: 'invalid' },
    });
  }
  const validate = await getRegistrationValidator();
  if (!validate(body)) {
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
  const { contact, phoneE164, consent } = await checkCoordinatorSubmission(req, reply, body);
  const invite = await usableInvite(token, 'coordinator');
  if (contact.email !== invite.email) throw httpError('INVITE_EMAIL_MISMATCH');
  await assertNotOrgOwner(contact.email);
  assertNoOrgDetails(body);
  const locations = ownLocations(body);

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
      inviteId: invite.jti,
      locations,
      log,
    });
    const keycloakUserId = await createCoordinatorLogin(userStore, idp, {
      aggregatorId,
      type: body.type,
      contact,
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
 * Refuses `url`, which belongs to the coordinator's org.
 *
 * `locations` is the coordinator's own address and is accepted; see {@link ownLocations}.
 *
 * @throws {HttpError} ORG_DETAILS_READ_ONLY.
 */
function assertNoOrgDetails(body: RegistrationPayload): void {
  if (body.url?.trim()) {
    throw httpError('ORG_DETAILS_READ_ONLY', { fields: { fields: ['url'] } });
  }
}

/**
 * The coordinator's own address to store in `users.locations`.
 *
 * Empty entries (no street, no locality, `[0,0]`) are dropped. A kept entry
 * must be a `Point` with `[longitude, latitude]` in range, as the address
 * autocomplete sends; `[0,0]` stands for "address typed, no place picked".
 *
 * @param body - The validated registration body.
 * @returns The locations to store; `[]` when none was given.
 * @throws {HttpError} SCHEMA_VALIDATION when a kept entry is not a valid point.
 */
function ownLocations(body: RegistrationPayload): BecknLocation[] {
  const kept = (body.locations ?? []).filter(hasLocationContent);
  for (const loc of kept) {
    const geo = loc.geo as { type?: unknown; coordinates?: unknown };
    const c = geo.coordinates;
    const valid =
      geo.type === 'Point' &&
      Array.isArray(c) &&
      c.length === 2 &&
      typeof c[0] === 'number' &&
      typeof c[1] === 'number' &&
      Math.abs(c[0]) <= 180 &&
      Math.abs(c[1]) <= 90;
    if (!valid) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'locations[].geo must be a Point with [longitude, latitude] in range.',
        fields: { 'locations.geo': 'invalid' },
      });
    }
  }
  return kept;
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
    inviteId: string;
    /** The coordinator's own address, from {@link ownLocations}. */
    locations: BecknLocation[];
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
    legacyOrgDetails: null,
    locations: row.locations,
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
 * Creates the invited coordinator's Keycloak user, enabled and unverified; on failure deletes the coordinator row.
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
  },
): Promise<string> {
  const { firstName, lastName } = splitName(user.contact.name);
  const created = await idp.createUser({
    email: user.contact.email,
    username: user.contact.email,
    phone: user.contact.phone,
    enabled: true,
    emailVerified: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.AGGREGATOR_ID]: user.aggregatorId,
      [KC_ATTR.AGGREGATOR_TYPE]: user.type,
      [KC_ATTR.PHONE_NUMBER]: user.contact.phone,
      [KC_ATTR.DECISION_MADE]: 'invited',
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
    /** The coordinator's own address (`users.locations`). */
    locations: BecknLocation[];
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
      locations: extras.locations,
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
