/**
 * Maps server field errors onto the public registration form (web app).
 */
import type { ErrorSchema } from '@rjsf/utils';
import { isRecord } from './is-record';

/**
 * Turns the API's `fields.field_errors` (`{ "address.city": "message" }`) into
 * an RJSF error schema, so each rejected field is marked inline.
 *
 * @param fieldErrors - The `field_errors` map from an error response, if any.
 * @returns The error schema, or `undefined` when there is nothing to mark.
 */
export function toErrorSchema(fieldErrors: unknown): ErrorSchema | undefined {
  if (!isRecord(fieldErrors)) return undefined;
  const root: ErrorSchema = {};
  let marked = false;
  for (const [path, message] of Object.entries(fieldErrors)) {
    if (typeof message !== 'string' || !path) continue;
    const segments = path.split('.');
    // Keys come from the server (and, through it, from Signals): a `__proto__`
    // segment would write onto Object.prototype, so such a path is skipped.
    if (segments.includes('__proto__')) continue;
    let node = root;
    for (const seg of segments) {
      const existing = Object.hasOwn(node, seg) ? node[seg] : undefined;
      const child: ErrorSchema = existing ?? {};
      node[seg] = child;
      node = child;
    }
    node.__errors = [...(node.__errors ?? []), message];
    marked = true;
  }
  return marked ? root : undefined;
}
