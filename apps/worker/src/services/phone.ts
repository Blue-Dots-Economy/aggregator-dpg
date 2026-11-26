/**
 * Phone checks for `@aggregator-dpg/worker`, bound to the deployment's
 * `PHONE_COUNTRIES`, the same rules the api applies.
 *
 * @module @aggregator-dpg/worker
 */

import {
  ALL_PHONE_COUNTRIES,
  parsePhone,
  phoneForSchema as sharedPhoneForSchema,
  type PhoneParseResult,
} from '@aggregator-dpg/shared-primitives/phone';
import { config } from '../config.js';

/**
 * Checks a participant's identity phone: a mobile in one of the deployment's countries.
 *
 * @param raw - The phone as written in the CSV row.
 * @returns The E.164 phone, or the reason it was refused.
 */
export function parseMobilePhone(raw: string): PhoneParseResult {
  return parsePhone(raw, { countries: config.PHONE_COUNTRIES, kind: 'mobile' });
}

/**
 * Reads a row's phone: any valid number in any country, so a person stored under
 * older, wider rules is still found. Signals refuses a non-mobile for a new person.
 *
 * @param raw - The phone as written in the CSV row.
 * @returns The E.164 phone, or the reason it was refused.
 */
export function parseKnownPhone(raw: string): PhoneParseResult {
  return parsePhone(raw, {
    countries: [config.PHONE_COUNTRIES[0], ...ALL_PHONE_COUNTRIES],
    kind: 'any',
  });
}

/**
 * The cleaned phone in the form the row schema takes: E.164, or the bare number on
 * networks that store one, for a phone from the deployment's default country.
 *
 * @param e164 - The cleaned phone.
 * @param schema - The row schema, or null when it did not load.
 * @param field - The phone column.
 * @returns The value to write into the row.
 */
export function phoneForSchema(
  e164: string,
  schema: Record<string, unknown> | null,
  field: string,
): string {
  return sharedPhoneForSchema(e164, schema, field, config.PHONE_COUNTRIES[0]);
}
