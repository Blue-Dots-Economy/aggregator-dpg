/**
 * Postgres driver-error helpers (`@aggregator-dpg/api`).
 *
 * Drizzle wraps the pg error, so the SQLSTATE `code` and `constraint` are on
 * `.cause`. Stores classify violations by SQLSTATE, never by matching message text.
 */

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_CHECK_VIOLATION = '23514';

/** Fields of a caught error that callers print or log. */
export type ErrorFieldName = 'code' | 'constraint' | 'table' | 'message' | 'name';

/**
 * String field of a caught error, such as a raw pg error's SQLSTATE `code`.
 *
 * Reads only the error itself, not its `cause` chain.
 *
 * @param err - Any value from a `catch` clause.
 * @param key - The field to read.
 * @returns The field when it is a string; otherwise `undefined`.
 */
export function errorField(err: unknown, key: ErrorFieldName): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const value: unknown = Reflect.get(err, key);
  return typeof value === 'string' ? value : undefined;
}

/** Walks the `.cause` chain (bounded) and returns the first string field found. */
function walkString(err: unknown, key: 'code' | 'constraint'): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; typeof cur === 'object' && cur !== null && depth < 5; depth++) {
    const value = errorField(cur, key);
    if (value !== undefined) return value;
    cur = Reflect.get(cur, 'cause');
  }
  return undefined;
}

/** The Postgres SQLSTATE for a thrown (possibly Drizzle-wrapped) error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  return walkString(err, 'code');
}

/** The violated constraint name for a thrown error, if the driver set one. */
export function pgConstraint(err: unknown): string | undefined {
  return walkString(err, 'constraint');
}
