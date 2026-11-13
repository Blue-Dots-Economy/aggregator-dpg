/**
 * Org invite endpoints of `@aggregator-dpg/api`.
 *
 *   GET  /v1/org/invite/read     check an org invite link for its registration page
 *   POST /v1/org/invite/accept   register the invited org and its owner under the inviting org
 *
 * Orgs live in `organisations` (`org_type = 'aggregator'`). No Signals org is created.
 */

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getOrganisationStore } from '../services/organisation-store/index.js';
import type { Organisation, OrgStoreError } from '../services/organisation-store/interface.js';
import { getUserStore } from '../services/user-store/index.js';
import { resolveProfileRef } from '../services/schema-ref.js';
import { getIdpAdmin, KC_ATTR, OWNER_CREATED_BY } from '../services/idp-admin/index.js';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { splitName } from '../services/name.js';
import { checkSubmitRate } from '../services/submit-rate.js';
import { slugFromName } from '../services/slug.js';
import { orgLocationsFrom } from '../services/org-location.js';
import { validateOrgRegistration } from '../services/org-schema-validator.js';
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

/** Attempts at a fresh random-suffixed slug when one collides. */
const ORG_SLUG_RETRIES = 3;
import { httpError } from '../errors/http-error.js';
import { errorResponses } from '../errors/openapi.js';
import { throwTreeRefusal } from './console-shared.js';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { getConsentLedger } from '../services/consent-ledger/index.js';
import type { RecordConsentHook } from '../services/consent-ledger/hook.js';
import { stampConsent } from '../services/registration-consent.js';
import { resolveActiveNetwork } from '@aggregator-dpg/network-config/paths';
import { getNetworkConfig } from '../services/network-config.js';
import { treeRules } from '../services/known-as.js';

/**
 * The fixed parts of an org invite accept body. Every other key is a field of
 * the deployment's org-registration schema: it passes through here and is
 * checked by {@link validateOrgRegistration}, so a schema field needs no code.
 * The parent is the inviting org, never the body.
 */
const OrgInviteAcceptBodySchema = z
  .object({
    invite: z.string().min(1).max(4096),
    display_name: z.string().min(1).max(200),
    state: z.string().max(200).optional(),
    owner: z.object({
      name: z.string().min(1).max(200),
      email: z.string().email(),
      phone: z.string().min(1),
    }),
    consent: z.object({
      value: z.literal(true),
      given_at: z.string(),
      valid_till: z.string(),
    }),
    /**
     * The org's address, as picked from the autocomplete.
     *
     * Every part is declared so older clients' bodies are not stripped by `z.object`.
     */
    address: z
      .object({
        streetAddress: z.string().max(500).optional(),
        addressLocality: z.string().max(200).optional(),
        addressDistrict: z.string().max(200).optional(),
        addressRegion: z.string().max(200).optional(),
        postalCode: z.string().max(20).optional(),
        addressCountry: z.string().max(100).optional(),
      })
      .optional(),
    /**
     * `[longitude, latitude]` for the picked address, GeoJSON order.
     *
     * Absent when the user typed an address without picking a suggestion.
     */
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  })
  .passthrough();

/**
 * Body keys stored elsewhere, so never copied into `profile`.
 *
 * `consent` is stored in the consent ledger.
 */
const ORG_COLUMN_BACKED_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'invite',
  'state',
  'owner',
  'consent',
]);

/**
 * Builds the `profile` payload: the schema-validated fields, plus the address
 * block and the picked coordinates, minus the keys stored elsewhere.
 *
 * The full address is kept because `locations` has no place for the district.
 *
 * @param schemaValues - Values {@link validateOrgRegistration} accepted.
 * @param address - The form's address block, when any.
 * @param coordinates - The picked address coordinates, when any.
 * @returns The `profile` payload; `{}` when the deployment declares no extra fields.
 */
function buildOrgProfile(
  schemaValues: Record<string, unknown>,
  address: z.infer<typeof OrgInviteAcceptBodySchema>['address'],
  coordinates: readonly [number, number] | undefined,
): Record<string, unknown> {
  const profile = Object.fromEntries(
    Object.entries(schemaValues).filter(
      ([key, value]) => !ORG_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
  if (address) profile['address'] = address;
  if (coordinates) profile['coordinates'] = coordinates;
  return profile;
}

/** `201` of an org invite accept: pending until the owner enters the email code. */
const OrgInviteAcceptedResponseSchema = z.object({
  org_id: z.string(),
  slug: z.string(),
  status: z.literal('pending'),
  message: z.string(),
  /** The invited owner email, passed to the sign-in page so the owner is not asked for it. */
  login_hint: z.string(),
});

/**
 * Registers the org registration + dropdown routes.
 *
 * @param app - Fastify instance to attach the routes to.
 */
export function registerAggregatorOrgRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/org/invite/accept',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Register an organisation from an invite',
        description:
          'Creates the invited org under the inviting org as `pending`, with its Keycloak group and an owner user that can sign in but holds no access yet. The owner email must be the invited address. The org becomes active when the owner signs in with an email code and calls `POST /v1/user/activate`; no approval. 409 ORG_DEPTH_LIMIT, ORG_CHILD_LIMIT or ORG_TOTAL_LIMIT when the inviting org can no longer take it. Reached with the web BFF service-account token.',
        body: OrgInviteAcceptBodySchema,
        response: {
          201: OrgInviteAcceptedResponseSchema,
          ...errorResponses(400, 401, 409, 410, 500, 503),
        },
      },
    },
    acceptOrgInvite,
  );

  app.get(
    '/v1/org/invite/read',
    {
      config: { rbac: { access: 'service' } },
      schema: {
        tags: ['aggregator-orgs'],
        summary: 'Read an organisation invite for its registration page',
        description:
          'Checks the invite link without using it up and returns the invited email and the inviting org. Reached with the web BFF service-account token.',
        querystring: InviteReadQuerySchema,
        response: {
          200: InviteReadResponseSchema,
          ...errorResponses(400, 401, 409, 410, 503),
        },
      },
    },
    inviteReadHandler('org_owner'),
  );
}

/**
 * Builds the consent-ledger write that `orgStore.create` runs inside its transaction.
 *
 * The consent config is read now, before the transaction. A failed ledger
 * write throws, so the store rolls back and answers `CONSENT_WRITE_FAILED`.
 *
 * @param consent - The server-stamped consent; its `valid_till` is stored.
 * @param log - Request-scoped child logger.
 * @returns The hook to pass as `recordConsent`.
 * @throws {HttpError} CONSENT_WRITE_FAILED when the consent config cannot be read.
 */
async function orgConsentWriter({
  consent,
  log,
}: {
  consent: { valid_till: string };
  log: ReturnType<FastifyRequest['log']['child']>;
}): Promise<RecordConsentHook> {
  const { network, brand } = resolveActiveNetwork();
  let termsVersion: number;
  let privacyVersion: number;
  try {
    const consentCfg = await loadConsentConfig(network, brand);
    termsVersion = consentCfg.audiences.org.documents.terms.current_version;
    privacyVersion = consentCfg.audiences.org.documents.privacy.current_version;
  } catch (e) {
    log.error(
      {
        operation: 'consentLedger.recordOrgConsent',
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

  return async (executor, orgId) => {
    const result = await getConsentLedger()
      .withExecutor(executor)
      .recordRegistrationConsent({
        subjectType: 'organisation',
        subjectId: orgId,
        network,
        brand: brand ?? null,
        termsVersion,
        privacyVersion,
        validTill: new Date(consent.valid_till),
      });
    if (!result.success) {
      log.error(
        {
          operation: 'consentLedger.recordOrgConsent',
          status: 'failure',
          error: result.error.message,
          error_type: result.error.name,
          org_id: orgId,
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
 * Reports whether an org owner's email or phone already belongs to someone else.
 *
 * A phone match on an org with the same owner email is not a clash.
 *
 * @param ownerEmail - Lowercased owner email.
 * @param phoneE164 - Canonical owner phone.
 * @returns `'email'`, `'phone'`, or `null` when the pair is free.
 * @throws {HttpError} `DB_UNAVAILABLE` when a lookup fails.
 */
async function findOwnerContactClash(
  ownerEmail: string,
  phoneE164: string,
): Promise<'email' | 'phone' | null> {
  const aggregators = getUserStore();
  const byEmail = await aggregators.findByContactEmail(ownerEmail);
  if (!byEmail.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (byEmail.value) return 'email';

  const byPhone = await aggregators.findByContactPhone(phoneE164);
  if (!byPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(byPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (byPhone.value) return 'phone';

  const orgByPhone = await getOrganisationStore().findByOwnerPhone(phoneE164);
  if (!orgByPhone.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(orgByPhone.error.message),
      fields: { sub_operation: 'orgStore.findByOwnerPhone' },
    });
  }
  if (orgByPhone.value && orgByPhone.value.ownerEmail !== ownerEmail) return 'phone';
  return null;
}

/**
 * Removes an org whose Keycloak setup failed part-way: its group, if any, and its row.
 *
 * Best effort; each failed step is logged.
 *
 * @param orgId - The half-created org.
 * @param groupId - Its Keycloak group id, or `null` when none was created.
 * @param log - Request logger.
 */
async function discardHalfCreatedOrg(
  orgId: string,
  groupId: string | null,
  log: FastifyBaseLogger,
): Promise<void> {
  if (groupId) {
    const g = await getIdpAdmin().deleteGroup(groupId);
    if (!g.ok) {
      log.warn(
        { status: 'failure', sub_operation: 'idp.deleteGroup', org_id: orgId, code: g.error.code },
        'could not remove the Keycloak group of a half-created org',
      );
    }
  }
  const d = await getOrganisationStore().deleteById(orgId);
  if (!d.ok) {
    log.warn(
      {
        status: 'failure',
        sub_operation: 'orgStore.deleteById',
        org_id: orgId,
        code: d.error.code,
      },
      'could not remove a half-created org row',
    );
  }
}

type OrgForm = z.infer<typeof OrgInviteAcceptBodySchema>;
type RequestLog = ReturnType<FastifyRequest['log']['child']>;

/**
 * Checks an org form against the deployment's org-registration schema and normalises the owner phone.
 *
 * @returns The schema-checked field values and the E.164 phone.
 * @throws {HttpError} SCHEMA_VALIDATION or INVALID_PHONE.
 */
async function checkOrgSubmission(
  body: OrgForm,
): Promise<{ schemaValues: Record<string, unknown>; phoneE164: string }> {
  const schemaCheck = await validateOrgRegistration(body);
  if (!schemaCheck.ok) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: Object.entries(schemaCheck.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; '),
      fields: { field_errors: schemaCheck.errors },
    });
  }
  const phoneResult = normalisePhone(body.owner.phone);
  if (!phoneResult.ok) {
    throw httpError('INVALID_PHONE', {
      detail: phoneResult.error.message,
      fields: { input: body.owner.phone },
    });
  }
  return { schemaValues: schemaCheck.values, phoneE164: phoneResult.value };
}

/**
 * Inserts a pending org and its consent row in one transaction, retrying on a slug collision.
 *
 * @throws {HttpError} ORG_NAME_TAKEN, ORG_SLUG_TAKEN, a tree limit, USER_EXISTS, PHONE_EXISTS, CONSENT_WRITE_FAILED or DB_UNAVAILABLE.
 */
async function createOrgRecord(
  orgStore: ReturnType<typeof getOrganisationStore>,
  body: OrgForm,
  input: {
    phoneE164: string;
    ownerEmail: string;
    schemaValues: Record<string, unknown>;
    parentId: string | undefined;
    log: RequestLog;
  },
): Promise<{ org: Organisation; slug: string }> {
  const orgProfileRef = resolveProfileRef('org-registration.v1.json');
  if (!orgProfileRef) {
    input.log.warn(
      {
        operation: 'org-registration.create',
        status: 'skipped',
        sub_operation: 'resolveProfileRef',
      },
      'org-registration schema not found — storing profile without a variant ref',
    );
  }
  const orgConsent = stampConsent(body.consent);
  if (!orgConsent) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'consent.valid_till must be in the future.',
      fields: { 'consent.valid_till': 'invalid' },
    });
  }
  const recordConsent = await orgConsentWriter({ consent: orgConsent, log: input.log });
  const rules = treeRules((await getNetworkConfig()).aggregator.organisation);
  let slug = slugFromName(body.display_name);
  const createOnce = (s: string) =>
    orgStore.create(
      {
        slug: s,
        displayName: body.display_name,
        state: body.address?.addressRegion ?? body.state ?? null,
        ownerEmail: input.ownerEmail,
        ownerPhone: input.phoneE164,
        ownerName: body.owner.name,
        locations: orgLocationsFrom(body.address, body.state, body.coordinates),
        profile: buildOrgProfile(input.schemaValues, body.address, body.coordinates),
        profileRef: orgProfileRef,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        recordConsent,
      },
      rules,
    );
  const createWithRetry = async (attempt: number): ReturnType<typeof createOnce> => {
    const result = await createOnce(slug);
    if (result.ok || result.error.code !== 'DUPLICATE_SLUG') return result;
    if (attempt + 1 >= ORG_SLUG_RETRIES) return result;
    slug = slugFromName(body.display_name);
    return createWithRetry(attempt + 1);
  };
  const created = await createWithRetry(0);
  if (!created.ok) throwOrgCreateError(created.error, body, { ...input, slug });
  return { org: created.value, slug };
}

/**
 * Maps a failed org insert to its HTTP error.
 *
 * @throws {HttpError} Always.
 */
function throwOrgCreateError(
  error: OrgStoreError,
  body: OrgForm,
  input: { phoneE164: string; parentId: string | undefined; slug: string },
): never {
  switch (error.code) {
    case 'DUPLICATE_NAME':
      throw httpError('ORG_NAME_TAKEN', { fields: { display_name: body.display_name } });
    case 'DUPLICATE_SLUG':
      throw httpError('ORG_SLUG_TAKEN', { fields: { slug: input.slug } });
    case 'DUPLICATE_EMAIL':
      throw httpError('USER_EXISTS', { fields: { email: body.owner.email } });
    case 'DUPLICATE_PHONE':
      throw httpError('PHONE_EXISTS', { fields: { phone: input.phoneE164 } });
    case 'CONSENT_WRITE_FAILED':
      throw httpError('CONSENT_WRITE_FAILED', {
        cause: new Error(error.message),
        fields: { sub_operation: 'recordOrgConsent', rolled_back: true },
      });
    default:
      throwTreeRefusal(error, { parent_id: input.parentId ?? null });
      throw httpError('DB_UNAVAILABLE', {
        cause: new Error(error.message),
        fields: { sub_operation: 'orgStore.create' },
      });
  }
}

/**
 * Creates the org's Keycloak group and its invited owner, enabled and unverified, and records them on the org.
 *
 * Any failure removes what was created, the org included, so a retry can succeed.
 *
 * @returns The Keycloak group id.
 * @throws {HttpError} USER_EXISTS, NAME_INVALID_CHARACTERS, IDP_UNAVAILABLE or DB_UNAVAILABLE.
 */
async function provisionOrgLogin(
  orgStore: ReturnType<typeof getOrganisationStore>,
  idp: ReturnType<typeof getIdpAdmin>,
  input: {
    org: Organisation;
    slug: string;
    owner: OrgForm['owner'];
    phoneE164: string;
    log: RequestLog;
  },
): Promise<{ groupId: string }> {
  const { org, owner, log } = input;
  const group = await idp.createGroup(`org-${input.slug}`, {
    org_id: org.id,
    display_name: org.displayName,
  });
  if (!group.ok) {
    await discardHalfCreatedOrg(org.id, null, log);
    throw httpError('IDP_UNAVAILABLE', {
      cause: new Error(group.error.message),
      fields: { sub_operation: 'idp.createGroup', rolled_back: true },
    });
  }

  const { firstName, lastName } = splitName(owner.name);
  const ownerUser = await idp.createUser({
    email: owner.email,
    username: owner.email,
    phone: input.phoneE164,
    enabled: true,
    emailVerified: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.PHONE_NUMBER]: input.phoneE164,
      [KC_ATTR.DECISION_MADE]: 'invited',
      [KC_ATTR.CREATED_BY]: OWNER_CREATED_BY,
    },
  });
  if (!ownerUser.ok) {
    await discardHalfCreatedOrg(org.id, group.value.id, log);
    if (ownerUser.error.code === 'USER_EXISTS') {
      throw httpError('USER_EXISTS', { fields: { email: owner.email, rolled_back: true } });
    }
    if (ownerUser.error.code === 'INVALID_NAME') {
      throw httpError('NAME_INVALID_CHARACTERS', {
        fields: { name: 'owner.name', rolled_back: true },
      });
    }
    throw httpError('IDP_UNAVAILABLE', {
      cause: new Error(ownerUser.error.message),
      fields: { sub_operation: 'idp.createUser', rolled_back: true },
    });
  }

  const stamped = await orgStore.update(org.id, {
    kcGroupId: group.value.id,
    ownerKcSub: ownerUser.value.id,
  });
  if (!stamped.ok) {
    await discardHalfCreatedOrg(org.id, group.value.id, log);
    const removed = await idp.deleteUser(ownerUser.value.id);
    if (!removed.ok) {
      log.warn(
        {
          status: 'failure',
          sub_operation: 'idp.deleteUser',
          org_id: org.id,
          code: removed.error.code,
        },
        'could not remove the Keycloak owner user of a half-created org',
      );
    }
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(stamped.error.message),
      fields: { sub_operation: 'orgStore.update.stamp', rolled_back: true },
    });
  }
  return { groupId: group.value.id };
}

/**
 * Refuses an owner email that already owns an org, and an email or phone another account holds.
 *
 * @throws {HttpError} OWNER_ALREADY_REGISTERED, USER_EXISTS, PHONE_EXISTS or DB_UNAVAILABLE.
 */
async function assertOwnerFree(
  ownerEmail: string,
  phoneE164: string,
  email: string,
): Promise<void> {
  const existing = await getOrganisationStore().findByOwnerEmail(ownerEmail);
  if (!existing.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(existing.error.message),
      fields: { sub_operation: 'orgStore.findByOwnerEmail' },
    });
  }
  if (existing.value) throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email } });
  const contactClash = await findOwnerContactClash(ownerEmail, phoneE164);
  if (contactClash === 'email') throw httpError('USER_EXISTS', { fields: { email } });
  if (contactClash === 'phone') throw httpError('PHONE_EXISTS', { fields: { phone: phoneE164 } });
}

/**
 * Registers an organisation from an invite.
 *
 * The owner email must be the invited one. The org is created `pending` under
 * the inviting org with a Keycloak owner that is enabled, unverified and
 * `decision_made = invited`; the owner's first email sign-in activates it. The
 * invite is claimed before anything is created and given back if the
 * registration does not complete.
 *
 * @throws {HttpError} On any refusal; the error code names the reason.
 */
async function acceptOrgInvite(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const log = req.log.child({ operation: 'invite.org.accept' });
  const start = Date.now();
  await authenticateCaller(req);

  const body = req.body as z.infer<typeof OrgInviteAcceptBodySchema>;
  const { schemaValues, phoneE164 } = await checkOrgSubmission(body);
  const ownerEmail = body.owner.email.toLowerCase();
  const invite = await usableInvite(body.invite, 'org_owner');
  if (ownerEmail !== invite.email) throw httpError('INVITE_EMAIL_MISMATCH');

  const rl = await checkSubmitRate(`${req.ip}|${ownerEmail}`);
  if (!rl.allowed) {
    void reply.header('Retry-After', String(rl.retryAfterSeconds));
    throw httpError('RATE_LIMITED', {
      detail: `Retry in ${rl.retryAfterSeconds}s.`,
      fields: { retry_after_seconds: rl.retryAfterSeconds },
    });
  }
  await assertOwnerFree(ownerEmail, phoneE164, body.owner.email);

  const orgStore = getOrganisationStore();
  await claimInvite(invite.jti);
  let committed = false;
  try {
    const { org, slug } = await createOrgRecord(orgStore, body, {
      phoneE164,
      ownerEmail,
      schemaValues,
      parentId: invite.org.isRoot ? undefined : invite.org.id,
      log,
    });
    const { groupId } = await provisionOrgLogin(orgStore, getIdpAdmin(), {
      org,
      slug,
      owner: body.owner,
      phoneE164,
      log,
    });
    committed = true;
    log.info(
      {
        status: 'success',
        latency_ms: Date.now() - start,
        org_id: org.id,
        slug,
        kc_group_id: groupId,
      },
      'invited org registered; awaiting owner email verification',
    );
    return reply.status(201).send({
      org_id: org.id,
      slug,
      status: 'pending',
      message: 'Organisation received. Sign in with the code we email you to finish.',
      login_hint: ownerEmail,
    });
  } finally {
    if (!committed) await releaseInvite(invite.jti, log);
  }
}
