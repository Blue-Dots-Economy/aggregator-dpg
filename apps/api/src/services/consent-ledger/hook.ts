/**
 * The consent write a store runs inside its create transaction
 * (`@aggregator-dpg/api`, migration 0029): the registration's
 * `consent_record` row commits with the account or org it belongs to, or
 * neither does.
 */

/**
 * Writes the registration's consent row inside the store's create
 * transaction. Throwing (any error) rolls the whole create back — the contact,
 * the row and the consent — and the store answers `CONSENT_WRITE_FAILED`.
 *
 * @param executor - The store's transaction (Postgres), or `undefined` for a
 *   store without transactions.
 * @param subjectId - The id of the row just inserted (user or organisation).
 */
export type RecordConsentHook = (executor: unknown, subjectId: string) => Promise<void>;

/**
 * A hook that writes nothing — for tests and fixtures that exercise a store
 * without the consent ledger. Never pass it from a route.
 */
export const NO_CONSENT_WRITE: RecordConsentHook = async () => {};
