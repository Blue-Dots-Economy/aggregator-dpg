/**
 * Application-side writes to `users` admin accounts and `user_identities`
 * (`@aggregator-dpg/api`, migration 0027).
 *
 * An org owner is an `admin` row of `users`: identity only, every
 * coordinator-only column NULL (`users_role_shape_chk`). These helpers run
 * INSIDE the caller's transaction (the `contact-writes.ts` pattern), so an org
 * and its owner's account are written atomically.
 *
 * Login identities are provider-neutral (`provider`, `subject`) and belong to
 * the account, never to `contact`.
 */

import { and, eq, sql } from 'drizzle-orm';
import { userIdentities } from './schema.js';
import type { DbExecutor } from './contact-writes.js';

/**
 * Returns the admin account of the person behind `contactId`, creating it when
 * absent, and holds it (`FOR KEY SHARE`) until the caller's transaction ends —
 * so a concurrent org delete cannot release the account before the org row
 * that will reference it is inserted. If it vanished in between, it is created
 * and held again (the `linkContact` hold-and-retry pattern).
 *
 * @param db - The caller's transaction.
 * @param contactId - The owner's contact id.
 * @returns The admin account's `users.id`.
 * @throws Error when the account cannot be created or held twice in a row.
 */
export async function linkAdminAccount(db: DbExecutor, contactId: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Explicit NULLs: the coordinator columns keep their defaults for
    // coordinator inserts, and the role CHECK requires NULL on admin rows.
    await db.execute(sql`
      INSERT INTO users (user_type, contact_id, status, locations, profile, contact_extra,
                         created_by, updated_by)
      VALUES ('admin', ${contactId}, NULL, NULL, NULL, NULL, 'self', 'self')
      ON CONFLICT (contact_id, user_type) DO NOTHING`);
    const held = await db.execute<{ id: string }>(sql`
      SELECT id FROM users
       WHERE contact_id = ${contactId} AND user_type = 'admin'
       FOR KEY SHARE`);
    const id = held.rows[0]?.id;
    if (id) return id;
  }
  throw new Error('admin account could not be created or held');
}

/** Outcome of {@link linkIdentity} when it does not throw. */
export type LinkIdentityOutcome = 'linked' | 'already';

/** The external login is already linked to a DIFFERENT account. */
export class IdentityTakenError extends Error {
  constructor() {
    super('login identity already belongs to another account');
    this.name = 'IdentityTakenError';
  }
}

/**
 * The account already has a DIFFERENT login for this provider (e.g. the IdP
 * user was recreated). Never overwritten silently: the caller logs it and an
 * operator decides.
 */
export class IdentityMismatchError extends Error {
  constructor() {
    super('account already has a different login for this provider');
    this.name = 'IdentityMismatchError';
  }
}

/**
 * Links a provider login to an account, once.
 *
 * @param db - Executor (the pool or the caller's transaction).
 * @param userId - The account (`users.id`).
 * @param provider - Provider key, e.g. `'keycloak'`.
 * @param subject - The provider's user id.
 * @returns `'linked'` when recorded now, `'already'` when this exact link exists.
 * @throws {IdentityTakenError} When the subject belongs to another account.
 * @throws {IdentityMismatchError} When the account has another subject for the provider.
 */
export async function linkIdentity(
  db: DbExecutor,
  userId: string,
  provider: string,
  subject: string,
): Promise<LinkIdentityOutcome> {
  const inserted = await db.execute<{ user_id: string }>(sql`
    INSERT INTO user_identities (user_id, provider, subject)
    VALUES (${userId}, ${provider}, ${subject})
    ON CONFLICT DO NOTHING
    RETURNING user_id`);
  if (inserted.rows.length > 0) return 'linked';

  const [mine] = await db
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  if (mine) {
    if (mine.subject === subject) return 'already';
    throw new IdentityMismatchError();
  }
  throw new IdentityTakenError();
}

/**
 * Returns the account's subject for `provider`, or null.
 *
 * @param db - Executor.
 * @param userId - The account.
 * @param provider - Provider key.
 * @returns The subject, or null when none is linked.
 */
export async function subjectOf(
  db: DbExecutor,
  userId: string,
  provider: string,
): Promise<string | null> {
  const [row] = await db
    .select({ subject: userIdentities.subject })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, provider)));
  return row?.subject ?? null;
}
