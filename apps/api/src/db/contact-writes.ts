/**
 * Application-side writes to the `contact` table (`@aggregator-dpg/api`).
 *
 * The aggregator and org Postgres stores call these INSIDE their own
 * transaction, so a contact and the row that references it are written
 * atomically. They are plain functions over a Drizzle executor rather than a
 * store behind an abstract contract, because the transaction handle must not
 * leak through a service interface (interfaces.md §5) and no caller outside
 * those two stores writes contacts.
 *
 * Unlike the best-effort sync triggers migration 0025 installed for the
 * previous release's writes (0026 drops them), these are strict: a clash with another person's email or phone raises the
 * database unique violation (`contact_email_unique` / `contact_phone_unique`),
 * which the calling store maps to `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`.
 *
 * Contact ids are PII-derived — never log them.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { contact } from './schema.js';
import type * as schema from './schema.js';

/** A Drizzle database or transaction handle. */
export type DbExecutor = Pick<
  NodePgDatabase<typeof schema>,
  'select' | 'insert' | 'update' | 'execute'
>;

/**
 * Thrown by {@link changeContact} when the contact is shared by another row
 * (one person holding two roles). Changing it would silently change the other
 * role's email/phone while Keycloak does not follow, so it is refused until
 * accounts are modelled separately.
 */
export class SharedContactError extends Error {
  constructor() {
    super('contact is shared by another role; changing its email or phone is not supported yet');
    this.name = 'SharedContactError';
  }
}

/**
 * Thrown by {@link changeContact} when the requested email + phone already
 * form ANOTHER person's contact (a row referenced by someone else). Moving onto
 * it would merge two people and let one overwrite the other's details.
 */
export class ContactTakenError extends Error {
  constructor() {
    super('the email and phone already belong to another person');
    this.name = 'ContactTakenError';
  }
}

/** Splits a Beckn contact into identity (`contact`) and the optional extras. */
export function splitBecknContact(c: {
  name: string;
  email: string;
  phone: string;
  alternatePhone?: string | undefined;
  company?: string | undefined;
  gstNumber?: string | undefined;
}): {
  identity: ContactInput;
  extra: { alternatePhone?: string; company?: string; gstNumber?: string };
} {
  const extra: { alternatePhone?: string; company?: string; gstNumber?: string } = {};
  if (c.alternatePhone !== undefined) extra.alternatePhone = c.alternatePhone;
  if (c.company !== undefined) extra.company = c.company;
  if (c.gstNumber !== undefined) extra.gstNumber = c.gstNumber;
  return { identity: { email: c.email, phone: c.phone, name: c.name }, extra };
}

/** Identity + name of the person a row belongs to. */
export interface ContactInput {
  /** Any casing; stored lowercased and trimmed. */
  email: string;
  /** Canonical (`normalisePhone`) phone, or `null`. */
  phone: string | null;
  /** Display name, or `null` when not captured. */
  name: string | null;
}

/**
 * Keeps a name verbatim (the API has always echoed names as submitted),
 * collapsing a blank one to `null` (the table rejects blank names).
 */
function cleanName(name: string | null | undefined): string | null {
  return name?.trim() ? name : null;
}

/**
 * Returns the id of the contact for `input`, creating it when absent. An
 * existing contact keeps its name unless it has none.
 *
 * @param db - Executor (normally the caller's transaction).
 * @param input - The person's email / phone / name.
 * @returns The contact id.
 * @throws {TypeError} When the email is blank or the phone is not canonical.
 * @throws The driver's unique-violation error when the email or phone belongs
 *   to a different contact.
 */
export async function linkContact(db: DbExecutor, input: ContactInput): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const id = contactId(email, input.phone);
  const name = cleanName(input.name);
  // Conflict target is the primary key ONLY: the same person resolves to the
  // same row, while a clash on email/phone alone (a different person) still
  // raises, so the caller can report it.
  await db
    .insert(contact)
    .values({ id, email, phone: input.phone, name })
    .onConflictDoNothing({ target: contact.id });
  if (name) {
    await db
      .update(contact)
      .set({ name })
      .where(and(eq(contact.id, id), isNull(contact.name)));
  }
  // Hold the row (FOR KEY SHARE) until the caller's transaction ends, so a
  // concurrent contact_gc() cannot delete it before the referencing insert's
  // FK check. If it vanished in between, create it again.
  const held = await db.execute(sql`SELECT 1 FROM contact WHERE id = ${id} FOR KEY SHARE`);
  if (held.rows.length === 0) {
    await db
      .insert(contact)
      .values({ id, email, phone: input.phone, name })
      .onConflictDoNothing({ target: contact.id });
    await db.execute(sql`SELECT 1 FROM contact WHERE id = ${id} FOR KEY SHARE`);
  }
  return id;
}

/**
 * Moves a row's contact to new details and returns the id the row must now
 * reference.
 *
 *   - same id           → name update only (an explicit update: new name wins)
 *   - target id exists  → {@link ContactTakenError} (another person's contact)
 *   - old contact shared with another row → {@link SharedContactError}
 *   - otherwise         → the old row is re-keyed in place; `ON UPDATE
 *                          CASCADE` moves every FK
 *
 * @param db - Executor (the caller's transaction).
 * @param oldId - The row's current contact id.
 * @param input - The new details.
 * @returns The contact id the row must reference afterwards.
 * @throws {SharedContactError} When another row shares the old contact.
 * @throws {ContactTakenError} When the new email + phone are another person's contact.
 * @throws The driver's unique-violation error on a clash with another person.
 */
export async function changeContact(
  db: DbExecutor,
  oldId: string,
  input: ContactInput,
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  const newId = contactId(email, input.phone);
  const name = cleanName(input.name);

  if (oldId === newId) {
    if (name) await db.update(contact).set({ name }).where(eq(contact.id, newId));
    return newId;
  }
  // Lock the current contact first, so the shared-or-not answer below cannot
  // change under us (a concurrent insert referencing it would otherwise be
  // re-keyed along with this row).
  await db.execute(sql`SELECT 1 FROM contact WHERE id = ${oldId} FOR UPDATE`);

  const [target] = await db.select({ id: contact.id }).from(contact).where(eq(contact.id, newId));
  if (target) {
    // Another person already has exactly this email + phone. Never merge onto
    // it (and never overwrite their name) — that is someone else's contact.
    throw new ContactTakenError();
  }

  const refs = await db.execute<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM aggregators WHERE contact_id = ${oldId})
         + (SELECT count(*) FROM aggregator_orgs WHERE contact_id = ${oldId}) AS n`);
  const shared = Number(refs.rows[0]?.n ?? 0) > 1;
  if (shared) throw new SharedContactError();

  await db
    .update(contact)
    .set({
      id: newId,
      email,
      phone: input.phone,
      ...(name ? { name } : {}),
    })
    .where(eq(contact.id, oldId));
  return newId;
}
