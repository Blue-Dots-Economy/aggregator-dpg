/**
 * Contact identity primitives shared by every aggregator process.
 *
 * A contact is one person's reachable identity — name, email, phone — stored
 * once in the `contact` table and referenced by FK (`contact_id`) from every
 * row that belongs to that person (coordinators, org owners). The row id is a
 * deterministic one-way hash of the canonical email + phone, so "does this
 * contact already exist?" is a single keyed lookup / `INSERT … ON CONFLICT`.
 *
 * The same formula is implemented in SQL as `contact_id_of(email, phone)`
 * (migration 0025); the golden-vector tests pin the two together. Change one
 * and you must change the other in the same commit.
 *
 * The id is PII-derived (an unsalted hash of email + phone can be brute-forced),
 * so it must never be logged, sent to telemetry, or placed in a URL.
 *
 * @module @aggregator-dpg/shared-primitives
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normaliseEmail } from '../phone/index.js';

/**
 * Canonical phone shape stored on a contact — exactly what `normalisePhone`
 * produces (`+` then 10–15 digits). Mirrors the SQL `contact_phone_chk`.
 */
export const CONTACT_PHONE_REGEX = /^\+[0-9]{10,15}$/;

/** Hex sha-256 id shape. Mirrors the SQL `contact_id_hex_chk`. */
export const CONTACT_ID_REGEX = /^[0-9a-f]{64}$/;

/** A stored contact row. */
export const ContactSchema = z.object({
  id: z.string().regex(CONTACT_ID_REGEX),
  email: z.string().min(1),
  phone: z.string().regex(CONTACT_PHONE_REGEX).nullable(),
  name: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** A stored contact row. */
export type Contact = z.infer<typeof ContactSchema>;

/**
 * Computes the deterministic contact id for an email + phone pair.
 *
 * Inputs must already be canonical — the email as produced by
 * `normaliseEmail`, the phone as produced by `normalisePhone` (or `null` when
 * the contact has none). The function re-applies the email normalisation so a
 * caller holding a raw address gets the same id the database computes, but it
 * does NOT normalise phones: a bare `9876543210` and `+919876543210` are
 * different inputs and would split one person across two ids, so a
 * non-canonical phone is rejected instead.
 *
 * @param email - The contact's email address.
 * @param phone - The contact's canonical phone, or `null`/`undefined` when absent.
 * @returns The 64-char lowercase hex sha-256 of `lower(email):phone`.
 * @throws {TypeError} When the email is blank or the phone is not canonical.
 */
export function contactId(email: string, phone: string | null | undefined): string {
  const canonicalEmail = normaliseEmail(email);
  if (!canonicalEmail) throw new TypeError('contactId: email is required');
  if (phone !== null && phone !== undefined && !CONTACT_PHONE_REGEX.test(phone)) {
    throw new TypeError('contactId: phone must be canonical (+ followed by 10-15 digits)');
  }
  return createHash('sha256')
    .update(`${canonicalEmail}:${phone ?? ''}`, 'utf8')
    .digest('hex');
}
