/**
 * Helpers for values thrown by `fetch`, in the signalstack-writer package.
 * Internal to the package; not a subpath export.
 */

const TIMEOUT_ERROR_NAMES = new Set(['TimeoutError', 'AbortError']);

/** Reads a string `name` from a thrown value, if it has one. */
function nameOf(v: unknown): string | undefined {
  return typeof v === 'object' && v !== null && 'name' in v && typeof v.name === 'string'
    ? v.name
    : undefined;
}

/**
 * True when a thrown fetch error is a timeout or abort, not a connection failure.
 *
 * Matches `TimeoutError` (from `AbortSignal.timeout()`) and `AbortError`
 * (from `AbortController.abort()`), on the value or its `cause`. Reads the
 * original value, so a thrown non-`Error` object is matched too.
 *
 * @param e - The value thrown by `fetch`.
 */
export function isTimeout(e: unknown): boolean {
  const outer = nameOf(e);
  const inner = typeof e === 'object' && e !== null && 'cause' in e ? nameOf(e.cause) : undefined;
  return (
    (outer !== undefined && TIMEOUT_ERROR_NAMES.has(outer)) ||
    (inner !== undefined && TIMEOUT_ERROR_NAMES.has(inner))
  );
}
