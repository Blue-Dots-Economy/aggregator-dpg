/**
 * Coordinator creation shared by the coordinator invite-accept route and operator provisioning.
 *
 * Checks the coordinator form, refuses a contact that is already taken, then
 * creates the coordinator row and its Keycloak user, removing the row when the
 * Keycloak step fails. Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  registrationDomains,
  type BecknContact,
  type BecknLocation,
  type ConsentRecord,
  type RegistrationPayload,
} from '@aggregator-dpg/shared-primitives/aggregator';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { getRegistrationValidator } from '../registration-validator.js';
import { stampConsent } from '../registration-consent.js';
import { getUserStore } from '../user-store/index.js';
import type { CreateCoordinatorInput, StoreError } from '../user-store/interface.js';
import type { RecordConsentHook } from '../consent-ledger/hook.js';
import { getNetworkConfig } from '../network-config.js';
import { resolveProfileRef } from '../schema-ref.js';
import { getIdpAdmin, KC_ATTR } from '../idp-admin/index.js';
import { splitName } from '../name.js';
import { slugFromName } from '../slug.js';

/** Attempts at a fresh random-suffixed slug when one collides. */
const SLUG_RETRIES = 3;

/**
 * A coordinator registration form. `consent` is optional here; the invite-accept
 * route requires it, operator provisioning leaves it out.
 */
export type CoordinatorForm = Omit<RegistrationPayload, 'consent'> & {
  consent?: RegistrationPayload['consent'];
};

/** Error codes of coordinator creation; each is a key of the API error catalogue. */
export type CoordinatorCreateErrorCode =
  | 'SCHEMA_VALIDATION'
  | 'INVALID_PHONE'
  | 'USER_EXISTS'
  | 'PHONE_EXISTS'
  | 'CONFLICT'
  | 'DUPLICATE_SLUG'
  | 'NAME_INVALID_CHARACTERS'
  | 'CONSENT_WRITE_FAILED'
  | 'IDP_UNAVAILABLE'
  | 'DB_UNAVAILABLE';

/** A refused or failed coordinator creation. */
export interface CoordinatorCreateError {
  code: CoordinatorCreateErrorCode;
  /** Replaces the catalogue detail for this occurrence. */
  detail?: string;
  fields?: Record<string, unknown>;
  cause?: Error;
}

/** Result of a coordinator-creation step. */
export type CoordinatorCreateResult<T> =
  { ok: true; value: T } | { ok: false; error: CoordinatorCreateError };

const ok = <T>(value: T): CoordinatorCreateResult<T> => ({ ok: true, value });
const fail = (error: CoordinatorCreateError): { ok: false; error: CoordinatorCreateError } => ({
  ok: false,
  error,
});

/** A checked coordinator form. */
export interface CheckedCoordinatorForm {
  /** The form's contact, with the phone in E.164. */
  contact: BecknContact;
  phoneE164: string;
  /** The server-stamped consent; `null` when the form has none. */
  consent: ConsentRecord | null;
  /** The domains picked, each a network domain id. */
  domains: string[];
}

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
function buildAggregatorProfile(body: CoordinatorForm): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) => !AGGREGATOR_COLUMN_BACKED_KEYS.has(key) && value !== undefined,
    ),
  );
}

/**
 * Checks a coordinator form against the network's domains and the registration schema, normalises its phone and stamps its consent.
 *
 * @param body - The parsed form.
 * @param opts.consentRequired - `false` accepts a form without consent (operator provisioning).
 * @returns The checked form, or SCHEMA_VALIDATION / INVALID_PHONE.
 */
export async function checkCoordinatorForm(
  body: CoordinatorForm,
  opts: { consentRequired: boolean },
): Promise<CoordinatorCreateResult<CheckedCoordinatorForm>> {
  const networkCfg = await getNetworkConfig();
  const domains = registrationDomains(body.type);
  const unknownDomains = domains.filter((d) => !networkCfg.domainIds.includes(d));
  if (unknownDomains.length > 0) {
    return fail({
      code: 'SCHEMA_VALIDATION',
      detail: `unknown type '${unknownDomains.join("', '")}' — valid: ${networkCfg.domainIds.join(', ')}`,
      fields: { type: 'invalid' },
    });
  }
  const validate = await getRegistrationValidator({ consentRequired: opts.consentRequired });
  if (!validate(body)) {
    return fail({
      code: 'SCHEMA_VALIDATION',
      detail: 'Payload failed JSON Schema validation.',
      fields: { issues: validate.errors ?? [] },
    });
  }
  const phoneResult = normalisePhone(body.contact.phone);
  if (!phoneResult.ok) {
    return fail({
      code: 'INVALID_PHONE',
      detail: phoneResult.error.message,
      fields: { phone: body.contact.phone },
    });
  }
  const phoneE164 = phoneResult.value;
  const contact: BecknContact = { ...body.contact, phone: phoneE164 };

  if (!body.consent) {
    if (opts.consentRequired) {
      return fail({
        code: 'SCHEMA_VALIDATION',
        detail: 'Consent is required.',
        fields: { consent: 'required' },
      });
    }
    return ok({ contact, phoneE164, consent: null, domains });
  }
  const consent = stampConsent(body.consent);
  if (!consent) {
    return fail({
      code: 'SCHEMA_VALIDATION',
      detail: 'consent.valid_till must be in the future.',
      fields: { 'consent.valid_till': 'invalid' },
    });
  }
  return ok({ contact, phoneE164, consent, domains });
}

/**
 * The coordinator's own address to store in `users.locations`.
 *
 * Empty entries (no street, no locality, `[0,0]`) are dropped. A kept entry
 * must be a `Point` with `[longitude, latitude]` in range, as the address
 * autocomplete sends; `[0,0]` stands for "address typed, no place picked".
 *
 * @param body - The validated registration body.
 * @returns The locations to store (`[]` when none was given), or SCHEMA_VALIDATION when a kept entry is not a valid point.
 */
export function ownLocations(body: CoordinatorForm): CoordinatorCreateResult<BecknLocation[]> {
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
      return fail({
        code: 'SCHEMA_VALIDATION',
        detail: 'locations[].geo must be a Point with [longitude, latitude] in range.',
        fields: { 'locations.geo': 'invalid' },
      });
    }
  }
  return ok(kept);
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

/**
 * Refuses an email or phone that already belongs to an account, in the database or Keycloak.
 *
 * @returns Nothing when both are free; USER_EXISTS, PHONE_EXISTS, DB_UNAVAILABLE or IDP_UNAVAILABLE otherwise.
 */
export async function assertContactFree(
  email: string,
  phoneE164: string,
): Promise<CoordinatorCreateResult<void>> {
  const userStore = getUserStore();
  const [dbEmail, dbPhone] = await Promise.all([
    userStore.findByContactEmail(email),
    userStore.findByContactPhone(phoneE164),
  ]);
  if (!dbEmail.ok) {
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(dbEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (dbEmail.value !== null) return fail({ code: 'USER_EXISTS', fields: { email } });
  if (!dbPhone.ok) {
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(dbPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (dbPhone.value !== null) return fail({ code: 'PHONE_EXISTS', fields: { phone: phoneE164 } });
  return assertNotInKeycloak(email, phoneE164);
}

/**
 * Refuses an email or phone that a Keycloak user already holds; the phone is the OTP login key.
 *
 * @returns Nothing when both are free; USER_EXISTS, PHONE_EXISTS or IDP_UNAVAILABLE otherwise.
 */
async function assertNotInKeycloak(
  email: string,
  phoneE164: string,
): Promise<CoordinatorCreateResult<void>> {
  const idp = getIdpAdmin();
  const kcEmail = await idp.findByEmail(email);
  if (!kcEmail.ok) {
    return fail({
      code: 'IDP_UNAVAILABLE',
      cause: new Error(kcEmail.error.message),
      fields: { sub_operation: 'idp.findByEmail' },
    });
  }
  if (kcEmail.value !== null) return fail({ code: 'USER_EXISTS', fields: { email } });
  const kcPhone = await idp.findByAttribute(KC_ATTR.PHONE_NUMBER, phoneE164);
  if (!kcPhone.ok) {
    return fail({
      code: 'IDP_UNAVAILABLE',
      cause: new Error(kcPhone.error.message),
      fields: { sub_operation: 'idp.findByAttribute.phoneNumber' },
    });
  }
  if (kcPhone.value !== null) return fail({ code: 'PHONE_EXISTS', fields: { phone: phoneE164 } });
  return ok(undefined);
}

/**
 * Maps a failed coordinator insert to its coordinator-creation error.
 *
 * @param error - The store error.
 */
function storeCreateFailure(error: StoreError): CoordinatorCreateError {
  const cause = new Error(error.message);
  switch (error.code) {
    case 'DUPLICATE_SLUG':
      return { code: 'DUPLICATE_SLUG', cause };
    // The ledger write failed inside the create transaction: nothing exists.
    case 'CONSENT_WRITE_FAILED':
      return {
        code: 'CONSENT_WRITE_FAILED',
        cause,
        fields: { sub_operation: 'recordAggregatorConsent', rolled_back: true },
      };
    // An unknown unique violation is a generic conflict.
    case 'DUPLICATE':
      return { code: 'CONFLICT', cause };
    case 'DUPLICATE_PHONE':
      return { code: 'PHONE_EXISTS', cause };
    case 'DUPLICATE_EMAIL':
      return { code: 'USER_EXISTS', cause };
    // Unreachable from routes, which always pass the consent hook.
    case 'CONSENT_REQUIRED':
      return {
        code: 'SCHEMA_VALIDATION',
        detail: 'Consent is required.',
        fields: { consent: 'required' },
        cause,
      };
    case 'CHECK_VIOLATION':
      return { code: 'SCHEMA_VALIDATION', cause };
    default:
      return { code: 'DB_UNAVAILABLE', cause };
  }
}

/**
 * Inserts a coordinator, retrying up to {@link SLUG_RETRIES} times on a slug collision.
 *
 * @param input - The insert without its slug, which is drawn from the name on each attempt.
 * @returns The last store result.
 */
async function createAggregatorWithSlug(
  input: Omit<CreateCoordinatorInput, 'orgSlug'>,
): ReturnType<ReturnType<typeof getUserStore>['create']> {
  const store = getUserStore();
  const createWithRetry = async (attempt: number): ReturnType<typeof store.create> => {
    const result = await store.create({ ...input, orgSlug: slugFromName(input.name) });
    if (result.ok || result.error.code !== 'DUPLICATE_SLUG') return result;
    if (attempt + 1 >= SLUG_RETRIES) return result;
    return createWithRetry(attempt + 1);
  };
  return createWithRetry(0);
}

/**
 * Creates the coordinator's Keycloak user: enabled, unverified and `decision_made = invited`.
 *
 * On failure deletes the coordinator row, so a retry can succeed.
 *
 * @returns The Keycloak user id, or USER_EXISTS / NAME_INVALID_CHARACTERS / IDP_UNAVAILABLE.
 */
async function createCoordinatorLogin(user: {
  userId: string;
  /** Every profile type served (multivalued claim). */
  domains: string[];
  contact: BecknContact;
  log: FastifyBaseLogger;
}): Promise<CoordinatorCreateResult<string>> {
  const { firstName, lastName } = splitName(user.contact.name);
  const created = await getIdpAdmin().createUser({
    email: user.contact.email,
    username: user.contact.email,
    phone: user.contact.phone,
    enabled: true,
    emailVerified: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.AGGREGATOR_ID]: user.userId,
      [KC_ATTR.AGGREGATOR_TYPE]: user.domains,
      [KC_ATTR.PHONE_NUMBER]: user.contact.phone,
      [KC_ATTR.DECISION_MADE]: 'invited',
    },
  });
  if (created.ok) return ok(created.value.id);
  const removed = await getUserStore().deleteById(user.userId);
  if (!removed.ok) {
    user.log.warn(
      {
        status: 'failure',
        sub_operation: 'userStore.deleteById',
        aggregator_id: user.userId,
        code: removed.error.code,
      },
      'could not remove a coordinator row whose Keycloak user was not created',
    );
  }
  const cause = new Error(created.error.message);
  if (created.error.code === 'USER_EXISTS') {
    return fail({
      code: 'USER_EXISTS',
      cause,
      fields: { email: user.contact.email, rolled_back: true },
    });
  }
  if (created.error.code === 'INVALID_NAME') {
    return fail({
      code: 'NAME_INVALID_CHARACTERS',
      fields: { name: 'contact.name', rolled_back: true },
    });
  }
  return fail({
    code: 'IDP_UNAVAILABLE',
    cause,
    fields: { sub_operation: 'idp.createUser', rolled_back: true },
  });
}

/**
 * Creates a pending coordinator and its Keycloak user, enabled, unverified and `decision_made = invited`.
 *
 * With a hook, the consent row is written in the create transaction. A
 * Keycloak failure removes the coordinator row.
 *
 * @param input.recordConsent - Writes the consent row in the create transaction; omit only for a provisioned `createdBy`.
 * @param input.locations - The coordinator's own address, from {@link ownLocations}.
 * @returns The coordinator id, its Signals slug and its Keycloak user id.
 */
export async function createCoordinatorWithLogin(input: {
  body: CoordinatorForm;
  contact: BecknContact;
  /** The domains served, validated and non-empty. */
  domains: string[];
  orgId: string;
  createdBy: string;
  consent: ConsentRecord | null;
  recordConsent?: RecordConsentHook;
  /** The consumed invite's `jti`; `null` when not registered through one. */
  inviteId: string | null;
  locations: BecknLocation[];
  log: FastifyBaseLogger;
}): Promise<CoordinatorCreateResult<{ userId: string; orgSlug: string; kcUserId: string }>> {
  const created = await createAggregatorWithSlug({
    name: input.body.name,
    type: input.domains[0] ?? null,
    serves: input.domains,
    contact: input.contact,
    consent: input.consent ?? undefined,
    recordConsent: input.recordConsent,
    createdBy: input.createdBy,
    updatedBy: input.createdBy,
    orgId: input.orgId,
    legacyOrgDetails: null,
    locations: input.locations,
    inviteId: input.inviteId,
    profile: buildAggregatorProfile(input.body),
    profileRef: resolveProfileRef('registration.v1.json'),
  });
  if (!created.ok) return fail(storeCreateFailure(created.error));
  const { id: userId, orgSlug } = created.value;

  const login = await createCoordinatorLogin({
    userId,
    domains: input.domains,
    contact: input.contact,
    log: input.log,
  });
  if (!login.ok) return login;
  return ok({ userId, orgSlug, kcUserId: login.value });
}
