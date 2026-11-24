/**
 * Phone checks for `@aggregator-dpg/api`, bound to the deployment's
 * `PHONE_COUNTRIES`.
 *
 * @module @aggregator-dpg/api
 */

import {
  parsePhone,
  phoneForSchema,
  type PhoneParseResult,
} from '@aggregator-dpg/shared-primitives/phone';
import { config } from '../config.js';

/**
 * Checks an identity phone (login, OTP, owner, participant): a mobile in one of
 * the deployment's countries.
 *
 * @param raw - The phone as typed.
 * @returns The E.164 phone, or the reason it was refused.
 */
export function parseMobilePhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: config.PHONE_COUNTRIES, kind: 'mobile' });
}

/**
 * Checks a contact phone (a number to call back), where landlines are fine.
 *
 * @param raw - The phone as typed.
 * @returns The E.164 phone, or the reason it was refused.
 */
export function parseContactPhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: config.PHONE_COUNTRIES, kind: 'any' });
}

/**
 * A cleaned phone in the form the schema field takes: E.164, or the bare number
 * on networks that store one, for a phone from the deployment's default country.
 *
 * @param e164 - The cleaned phone.
 * @param schema - The form's JSON schema.
 * @param field - The phone property.
 * @returns The value to validate and store.
 */
export function phoneForField(
  e164: string,
  schema: Record<string, unknown> | null,
  field: string,
): string {
  return phoneForSchema(e164, schema, field, config.PHONE_COUNTRIES[0]);
}
