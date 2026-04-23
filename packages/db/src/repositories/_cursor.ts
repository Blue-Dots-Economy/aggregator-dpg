/**
 * Cursor encoding/decoding for keyset pagination.
 *
 * Cursor encodes the last item's (createdAt, id) pair as a base64url JSON
 * string. Repositories use this to produce and consume nextCursor values in
 * Paginated<T> responses.
 *
 * @module @aggregator-dpg/db/repositories (internal)
 */

interface CursorPayload {
  id: string;
  createdAt: string;
}

/**
 * Encodes the last item's identity into an opaque pagination cursor.
 *
 * @param id - UUID of the last item in the current page.
 * @param createdAt - createdAt timestamp of the last item.
 * @returns Opaque base64url cursor string.
 */
export function encodeCursor(id: string, createdAt: Date): string {
  const payload: CursorPayload = { id, createdAt: createdAt.toISOString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor back into its component fields.
 *
 * @param cursor - Opaque base64url cursor string from a prior response.
 * @returns Decoded id and createdAt for use in WHERE clauses.
 * @throws {Error} If the cursor is malformed or cannot be decoded.
 */
export function decodeCursor(cursor: string): { id: string; createdAt: Date } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const payload = JSON.parse(raw) as CursorPayload;
  return { id: payload.id, createdAt: new Date(payload.createdAt) };
}
