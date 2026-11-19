/**
 * Body checks and Signals error mapping shared by the public registration
 * routes of the aggregator API (`@aggregator-dpg/api`): the form submit and
 * the voice-bot request.
 *
 * Every check throws the `httpError` the route answers with.
 */

import type { IdentitySelectors } from '@aggregator-dpg/network-config/interface';
import { fieldLabel, formatFieldErrors } from '@aggregator-dpg/network-config/field-errors';
import type { ComplianceEntry } from '@aggregator-dpg/signalstack-writer/interface';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import { httpError, type HttpError } from '../errors/http-error.js';

/** Oldest age, in years, at which a registrant counts as a minor here. */
const MINOR_MAX_AGE = 18;

/**
 * String value of a body field.
 *
 * @returns The value when `key` is set and the field is a string; otherwise `undefined`.
 */
export function readString(
  body: Record<string, unknown>,
  key: string | undefined,
): string | undefined {
  if (!key) return undefined;
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Checks an identity-only body: only identity, consent and birth-year keys,
 * a name, and a contact.
 *
 * Runs before anything else reads the body, because the client can be tampered with.
 *
 * @param rawBody - The request body as received.
 * @param identity - The domain's identity field names.
 * @param opts - `requirePhone`: the phone is the only accepted contact; `allowEmail`: the email key is accepted.
 * @throws {HttpError} `REGISTRATION_MODE_MISMATCH` for any other key; `SCHEMA_VALIDATION` when the name or contact is missing.
 */
export function checkAccountOnlyBody(
  rawBody: Record<string, unknown>,
  identity: IdentitySelectors,
  opts: { requirePhone: boolean; allowEmail: boolean },
): void {
  const allowed = new Set<string>([
    'consent_terms',
    'consent_privacy',
    // Year of birth (or `age` from older clients) is allowed with consent on
    // guardian-gated domains.
    'age',
    'year_of_birth',
    ...[identity.name, identity.phone, opts.allowEmail ? identity.email : undefined].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    ),
  ]);
  for (const key of Object.keys(rawBody)) {
    if (!allowed.has(key)) {
      throw httpError('REGISTRATION_MODE_MISMATCH', {
        detail: `account_only link does not accept field '${key}'`,
        fields: { rejected_key: key },
      });
    }
  }
  // Require name and a contact; otherwise the writer would answer 502.
  const hasName = Boolean(readString(rawBody, identity.name));
  const hasPhone = Boolean(readString(rawBody, identity.phone));
  if (opts.requirePhone) {
    if (!hasName || !hasPhone) {
      throw httpError('SCHEMA_VALIDATION', {
        detail: 'A voice request requires name and phone.',
        fields: {
          missing: [...(!hasName ? [identity.name] : []), ...(!hasPhone ? [identity.phone] : [])],
        },
      });
    }
    return;
  }
  const hasEmail = Boolean(readString(rawBody, identity.email));
  if (!hasName || (!hasPhone && !hasEmail)) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'account_only requires name and at least one of phone or email',
      fields: {
        missing: [
          ...(!hasName ? [identity.name] : []),
          ...(!hasPhone && !hasEmail ? ['phone_or_email'] : []),
        ],
      },
    });
  }
}

/** Consent and age to send to Signals for one registrant. */
export interface ConsentAndAge {
  /** Compliance points; set only for an adult on a consent-gated domain. */
  compliance?: ComplianceEntry[];
  /** Age in years; never set for a minor. */
  age?: number;
  /** True when the birth year (or `age`) puts the registrant at 18 or under. */
  isMinor: boolean;
}

/**
 * Reads the consent booleans and birth year, strips them from the body, and
 * decides what consent and age to send.
 *
 * A minor cannot give consent here; they accept terms in the Signals app, and
 * Signals rejects an onboard with top-level `age < 18`. So a minor gets
 * neither age nor compliance. An adult must consent on a consent-gated domain.
 * Unknown age is treated as adult.
 *
 * @param body - Submission body; `consent_*` and `year_of_birth` are deleted from it.
 * @param opts - `consentRequired`: the domain gates go-live on consent; `withItem`: a profile is created, so `profile_creation` is required too.
 * @throws {HttpError} `CONSENT_REQUIRED` when an adult has not given every required consent.
 */
export function resolveConsentAndAge(
  body: Record<string, unknown>,
  opts: { consentRequired: boolean; withItem: boolean },
): ConsentAndAge {
  const termsOk = body['consent_terms'] === true;
  const privacyOk = body['consent_privacy'] === true;
  const profileConsentOk = body['consent_profile'] === true;
  delete body['consent_terms'];
  delete body['consent_privacy'];
  delete body['consent_profile'];

  // Only this top-level birth year (or `age` from older clients) triggers the
  // minor rule, not a profile `age` field.
  const yobRaw = body['year_of_birth'];
  delete body['year_of_birth'];
  const yob = coerceNum(yobRaw);
  const derivedAge = yob !== undefined ? new Date().getUTCFullYear() - yob : coerceNum(body['age']);

  const isMinor = derivedAge !== undefined && derivedAge <= MINOR_MAX_AGE;
  if (opts.consentRequired && !isMinor) {
    const missingConsent: string[] = [];
    if (!termsOk) missingConsent.push('user_terms');
    if (!privacyOk) missingConsent.push('user_privacy');
    if (opts.withItem && !profileConsentOk) missingConsent.push('profile_creation');
    if (missingConsent.length > 0) {
      throw httpError('CONSENT_REQUIRED', { fields: { missing: missingConsent } });
    }
  }
  const age = isMinor ? undefined : derivedAge;
  if (!opts.consentRequired || isMinor) {
    return { isMinor, ...(age !== undefined ? { age } : {}) };
  }
  return {
    isMinor,
    ...(age !== undefined ? { age } : {}),
    compliance: [
      { key: 'user_terms', value: true },
      { key: 'user_privacy', value: true },
      ...(opts.withItem ? [{ key: 'profile_creation', value: true }] : []),
    ],
  };
}

/**
 * Maps a failed Signals `onboard` to the error the route answers with.
 *
 * `U18_NOT_ALLOWED` becomes the finish-in-the-app redirect. A Signals
 * `INVALID_ITEM_STATE` with per-field messages is the participant's input, so
 * it becomes a 400 naming each field. A profile-limit message is shown as is.
 * Anything else is a 502 with a generic message.
 *
 * @param error - The writer's error.
 * @param domainSchema - The domain's JSON Schema, for field labels.
 * @returns The error to throw.
 */
export function onboardFailureError(error: BaseError, domainSchema: unknown): HttpError {
  if (error.message.includes('U18_NOT_ALLOWED')) {
    return httpError('U18_REGISTRATION_REDIRECT', {
      fields: { code: error.code, message: error.message },
      cause: error,
    });
  }
  const details = error.details;
  if (
    details?.upstreamCode === 'INVALID_ITEM_STATE' &&
    isStringMap(details.signalsFields) &&
    Object.keys(details.signalsFields).length > 0
  ) {
    const signalsFields = details.signalsFields;
    return httpError('SCHEMA_VALIDATION', {
      detail: formatFieldErrors(
        Object.entries(signalsFields).map(([field, message]) => ({
          field,
          label: fieldLabel(domainSchema, field),
          message,
        })),
      ),
      fields: {
        field_errors: signalsFields,
        upstream_code: details.upstreamCode,
      },
      cause: error,
    });
  }
  const signalsMessage = details?.signalsMessage;
  const detail =
    error.code === 'SIGNALSTACK_PROFILE_LIMIT_REACHED' && typeof signalsMessage === 'string'
      ? signalsMessage
      : `Signalstack rejected the participant push (${error.code}).`;
  return httpError('SIGNALSTACK_PUSH_FAILED', {
    detail,
    fields: { code: error.code, message: error.message },
    cause: error,
  });
}

/** Number from a number or a numeric string; otherwise `undefined`. */
function coerceNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** True for a plain `{ string: string }` object such as Signals' `fields` map. */
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}
