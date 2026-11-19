/**
 * Org creation shared by the org invite-accept route and operator provisioning.
 *
 * Creates the org row, its Keycloak group and its owner, and removes what it
 * created when a later step fails. Belongs to `@aggregator-dpg/api`.
 */

import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { normalisePhone } from '@aggregator-dpg/shared-primitives/phone';
import { getOrganisationStore } from '../organisation-store/index.js';
import type { Organisation, OrgStoreError } from '../organisation-store/interface.js';
import { getUserStore } from '../user-store/index.js';
import { resolveProfileRef } from '../schema-ref.js';
import { getIdpAdmin, KC_ATTR, OWNER_CREATED_BY } from '../idp-admin/index.js';
import { splitName } from '../name.js';
import { slugFromName } from '../slug.js';
import { orgLocationsFrom } from '../org-location.js';
import { validateOrgRegistration } from '../org-schema-validator.js';
import type { RecordConsentHook } from '../consent-ledger/hook.js';
import { getNetworkConfig } from '../network-config.js';
import { treeRules } from '../known-as.js';
import { treeRefusalError, type TreeRefusalCode } from '../org-tree-refusal.js';

/** Attempts at a fresh random-suffixed slug when one collides. */
const ORG_SLUG_RETRIES = 3;

/**
 * The fixed parts of an org registration form. Every other key is a field of
 * the deployment's org-registration schema: it passes through here and is
 * checked by {@link validateOrgRegistration}, so a schema field needs no code.
 */
export const OrgFormSchema = z
  .object({
    display_name: z.string().min(1).max(200),
    state: z.string().max(200).optional(),
    owner: z.object({
      name: z.string().min(1).max(200),
      email: z.email(),
      phone: z.string().min(1),
    }),
    /** Optional here; the invite-accept route requires it. */
    consent: z
      .object({
        value: z.literal(true),
        given_at: z.string(),
        valid_till: z.string(),
      })
      .optional(),
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
  .loose();

/** An org registration form. */
export type OrgForm = z.infer<typeof OrgFormSchema>;

/** Error codes of org creation; each is a key of the API error catalogue. */
export type OrgCreateErrorCode =
  | 'SCHEMA_VALIDATION'
  | 'INVALID_PHONE'
  | 'ORG_NAME_TAKEN'
  | 'ORG_SLUG_TAKEN'
  | 'USER_EXISTS'
  | 'PHONE_EXISTS'
  | 'NAME_INVALID_CHARACTERS'
  | 'CONSENT_WRITE_FAILED'
  | 'IDP_UNAVAILABLE'
  | 'DB_UNAVAILABLE'
  | TreeRefusalCode;

/** A refused or failed org creation. */
export interface OrgCreateError {
  code: OrgCreateErrorCode;
  /** Replaces the catalogue detail for this occurrence. */
  detail?: string;
  fields?: Record<string, unknown>;
  cause?: Error;
}

/** Result of an org-creation step. */
export type OrgCreateResult<T> = { ok: true; value: T } | { ok: false; error: OrgCreateError };

const ok = <T>(value: T): OrgCreateResult<T> => ({ ok: true, value });
const fail = (error: OrgCreateError): { ok: false; error: OrgCreateError } => ({
  ok: false,
  error,
});

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
  address: OrgForm['address'],
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

/**
 * Checks an org form against the deployment's org-registration schema and normalises the owner phone.
 *
 * @param body - The org form.
 * @returns The schema-checked field values and the E.164 phone, or SCHEMA_VALIDATION / INVALID_PHONE.
 */
export async function checkOrgForm(
  body: OrgForm,
): Promise<OrgCreateResult<{ schemaValues: Record<string, unknown>; phoneE164: string }>> {
  const schemaCheck = await validateOrgRegistration(body);
  if (!schemaCheck.ok) {
    return fail({
      code: 'SCHEMA_VALIDATION',
      detail: Object.entries(schemaCheck.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; '),
      fields: { field_errors: schemaCheck.errors },
    });
  }
  const phoneResult = normalisePhone(body.owner.phone);
  if (!phoneResult.ok) {
    return fail({
      code: 'INVALID_PHONE',
      detail: phoneResult.error.message,
      fields: { input: body.owner.phone },
    });
  }
  return ok({ schemaValues: schemaCheck.values, phoneE164: phoneResult.value });
}

/**
 * Reports whether an org owner's email or phone already belongs to someone else.
 *
 * A phone match on an org with the same owner email is not a clash.
 *
 * @param ownerEmail - Lowercased owner email.
 * @param phoneE164 - Canonical owner phone.
 * @returns `'email'`, `'phone'`, or `null` when the pair is free; DB_UNAVAILABLE when a lookup fails.
 */
export async function findOwnerContactClash(
  ownerEmail: string,
  phoneE164: string,
): Promise<OrgCreateResult<'email' | 'phone' | null>> {
  const aggregators = getUserStore();
  const byEmail = await aggregators.findByContactEmail(ownerEmail);
  if (!byEmail.ok) {
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(byEmail.error.message),
      fields: { sub_operation: 'userStore.findByContactEmail' },
    });
  }
  if (byEmail.value) return ok('email');

  const byPhone = await aggregators.findByContactPhone(phoneE164);
  if (!byPhone.ok) {
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(byPhone.error.message),
      fields: { sub_operation: 'userStore.findByContactPhone' },
    });
  }
  if (byPhone.value) return ok('phone');

  const orgByPhone = await getOrganisationStore().findByOwnerPhone(phoneE164);
  if (!orgByPhone.ok) {
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(orgByPhone.error.message),
      fields: { sub_operation: 'orgStore.findByOwnerPhone' },
    });
  }
  if (orgByPhone.value && orgByPhone.value.ownerEmail !== ownerEmail) return ok('phone');
  return ok(null);
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

/**
 * Maps a failed org insert to its org-creation error.
 *
 * @param error - The store error.
 * @param form - The submitted form.
 * @param input - The phone, parent and slug of the failed insert.
 */
function orgStoreFailure(
  error: OrgStoreError,
  form: OrgForm,
  input: { phoneE164: string; parentId: string | undefined; slug: string },
): OrgCreateError {
  const refusal = treeRefusalError(error, { parent_id: input.parentId ?? null });
  if (refusal) return refusal;
  switch (error.code) {
    case 'DUPLICATE_NAME':
      return { code: 'ORG_NAME_TAKEN', fields: { display_name: form.display_name } };
    case 'DUPLICATE_SLUG':
      return { code: 'ORG_SLUG_TAKEN', fields: { slug: input.slug } };
    case 'DUPLICATE_EMAIL':
      return { code: 'USER_EXISTS', fields: { email: form.owner.email } };
    case 'DUPLICATE_PHONE':
      return { code: 'PHONE_EXISTS', fields: { phone: input.phoneE164 } };
    case 'CONSENT_WRITE_FAILED':
      return {
        code: 'CONSENT_WRITE_FAILED',
        cause: new Error(error.message),
        fields: { sub_operation: 'recordOrgConsent', rolled_back: true },
      };
    case 'CONSENT_REQUIRED':
      return {
        code: 'SCHEMA_VALIDATION',
        detail: 'Consent is required.',
        fields: { consent: 'required' },
      };
    default:
      return {
        code: 'DB_UNAVAILABLE',
        cause: new Error(error.message),
        fields: { sub_operation: 'orgStore.create' },
      };
  }
}

/**
 * Inserts a pending org (and, with a hook, its consent row) in one transaction, retrying on a slug collision.
 *
 * @returns The org and its slug, or the mapped store failure.
 */
async function createOrgRecord(input: {
  form: OrgForm;
  phoneE164: string;
  schemaValues: Record<string, unknown>;
  parentId: string | undefined;
  createdBy: string;
  recordConsent: RecordConsentHook | undefined;
  log: FastifyBaseLogger;
}): Promise<OrgCreateResult<{ org: Organisation; slug: string }>> {
  const { form } = input;
  const orgStore = getOrganisationStore();
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
  const rules = treeRules((await getNetworkConfig()).aggregator.organisation);
  let slug = slugFromName(form.display_name);
  const createOnce = (s: string) =>
    orgStore.create(
      {
        slug: s,
        displayName: form.display_name,
        state: form.address?.addressRegion ?? form.state ?? null,
        ownerEmail: form.owner.email.toLowerCase(),
        ownerPhone: input.phoneE164,
        ownerName: form.owner.name,
        locations: orgLocationsFrom(form.address, form.state, form.coordinates),
        profile: buildOrgProfile(input.schemaValues, form.address, form.coordinates),
        profileRef: orgProfileRef,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        createdBy: input.createdBy,
        recordConsent: input.recordConsent,
      },
      rules,
    );
  const createWithRetry = async (attempt: number): ReturnType<typeof createOnce> => {
    const result = await createOnce(slug);
    if (result.ok || result.error.code !== 'DUPLICATE_SLUG') return result;
    if (attempt + 1 >= ORG_SLUG_RETRIES) return result;
    slug = slugFromName(form.display_name);
    return createWithRetry(attempt + 1);
  };
  const created = await createWithRetry(0);
  if (!created.ok) {
    return fail(
      orgStoreFailure(created.error, form, {
        phoneE164: input.phoneE164,
        parentId: input.parentId,
        slug,
      }),
    );
  }
  return ok({ org: created.value, slug });
}

/**
 * Creates the invited owner's Keycloak user: enabled, unverified and `decision_made = invited`.
 *
 * @returns The Keycloak user id, or USER_EXISTS / NAME_INVALID_CHARACTERS / IDP_UNAVAILABLE.
 */
async function createOwnerUser(
  owner: OrgForm['owner'],
  phoneE164: string,
): Promise<OrgCreateResult<string>> {
  const { firstName, lastName } = splitName(owner.name);
  const ownerUser = await getIdpAdmin().createUser({
    email: owner.email,
    username: owner.email,
    phone: phoneE164,
    enabled: true,
    emailVerified: false,
    firstName,
    lastName,
    attributes: {
      [KC_ATTR.PHONE_NUMBER]: phoneE164,
      [KC_ATTR.DECISION_MADE]: 'invited',
      [KC_ATTR.CREATED_BY]: OWNER_CREATED_BY,
    },
  });
  if (ownerUser.ok) return ok(ownerUser.value.id);
  if (ownerUser.error.code === 'USER_EXISTS') {
    return fail({ code: 'USER_EXISTS', fields: { email: owner.email, rolled_back: true } });
  }
  if (ownerUser.error.code === 'INVALID_NAME') {
    return fail({
      code: 'NAME_INVALID_CHARACTERS',
      fields: { name: 'owner.name', rolled_back: true },
    });
  }
  return fail({
    code: 'IDP_UNAVAILABLE',
    cause: new Error(ownerUser.error.message),
    fields: { sub_operation: 'idp.createUser', rolled_back: true },
  });
}

/**
 * Creates a pending org with its Keycloak group and owner, and records both on the org.
 *
 * Without `existingOwnerKcSub` the owner is created in Keycloak, enabled,
 * unverified and `decision_made = invited`; with it, that user is the owner.
 * Any failure removes what this call created, the org included, so a retry
 * can succeed. A pre-existing owner user is never removed.
 *
 * @param input.recordConsent - Writes the consent row in the create transaction; omit only for a provisioned `createdBy`.
 * @returns The org (with `kcGroupId` and `ownerKcSub` set), its slug, group id and owner sub.
 */
export async function createOrgWithOwner(input: {
  form: OrgForm;
  schemaValues: Record<string, unknown>;
  phoneE164: string;
  parentId?: string;
  createdBy: string;
  recordConsent?: RecordConsentHook;
  existingOwnerKcSub?: string;
  log: FastifyBaseLogger;
}): Promise<
  OrgCreateResult<{ org: Organisation; slug: string; groupId: string; ownerKcSub: string }>
> {
  const { form, phoneE164, log } = input;
  const record = await createOrgRecord({
    form,
    phoneE164,
    schemaValues: input.schemaValues,
    parentId: input.parentId,
    createdBy: input.createdBy,
    recordConsent: input.recordConsent,
    log,
  });
  if (!record.ok) return record;
  const { org, slug } = record.value;
  const idp = getIdpAdmin();

  const group = await idp.createGroup(`org-${slug}`, {
    org_id: org.id,
    display_name: org.displayName,
  });
  if (!group.ok) {
    await discardHalfCreatedOrg(org.id, null, log);
    return fail({
      code: 'IDP_UNAVAILABLE',
      cause: new Error(group.error.message),
      fields: { sub_operation: 'idp.createGroup', rolled_back: true },
    });
  }
  const groupId = group.value.id;

  let ownerKcSub: string;
  if (input.existingOwnerKcSub) {
    ownerKcSub = input.existingOwnerKcSub;
  } else {
    const created = await createOwnerUser(form.owner, phoneE164);
    if (!created.ok) {
      await discardHalfCreatedOrg(org.id, groupId, log);
      return created;
    }
    ownerKcSub = created.value;
  }

  const stamped = await getOrganisationStore().update(org.id, { kcGroupId: groupId, ownerKcSub });
  if (!stamped.ok) {
    await discardHalfCreatedOrg(org.id, groupId, log);
    if (!input.existingOwnerKcSub) {
      const removed = await idp.deleteUser(ownerKcSub);
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
    }
    return fail({
      code: 'DB_UNAVAILABLE',
      cause: new Error(stamped.error.message),
      fields: { sub_operation: 'orgStore.update.stamp', rolled_back: true },
    });
  }
  return ok({ org: stamped.value, slug, groupId, ownerKcSub });
}
