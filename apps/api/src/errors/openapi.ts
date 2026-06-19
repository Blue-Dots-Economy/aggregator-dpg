/**
 * OpenAPI helpers for the canonical error envelope. Routes spread
 * `errorResponses(...)` into their `schema.response` map so every declared
 * error status documents (and safely serializes) the standard envelope
 * produced by the global error handler.
 */

import { z } from 'zod';
import type { ErrorEnvelope } from './serialize.js';

/**
 * Zod mirror of {@link import('./serialize.js').ErrorEnvelope}. Passthrough
 * on every object so the serializer can never strip envelope fields.
 */
export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        title: z.string(),
        detail: z.string(),
        docs: z.string().optional(),
        fields: z.record(z.unknown()).optional(),
        requestId: z.string(),
        timestamp: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Compile-time anchor: if the schema's inferred output drifts from the real
 * {@link ErrorEnvelope} wire type produced by the error handler (missing
 * field, wrong type, required field made optional), this fails to typecheck.
 *
 * Passthrough widens the output beyond the exact type, and zod infers
 * optionals as `T | undefined` (rejected verbatim under
 * `exactOptionalPropertyTypes`), so the guard widens the target's property
 * types with `| undefined` instead of using a direct `z.ZodType` assignment.
 */
type _Expect<T extends true> = T;
type _WidenOptional<T> = { [K in keyof T]: T[K] | undefined };
type _ErrorEnvelopeSchemaMatchesType = _Expect<
  z.infer<typeof ErrorEnvelopeSchema> extends { error: _WidenOptional<ErrorEnvelope['error']> }
    ? true
    : false
>;

/**
 * Builds a `{ <status>: ErrorEnvelopeSchema }` map for the given HTTP
 * statuses, deduplicating repeats, for spreading into a route's
 * `schema.response`.
 *
 * @param statuses - HTTP status codes the route can return as errors.
 * @returns Map of status code to the canonical error envelope schema.
 */
export function errorResponses(...statuses: number[]): Record<number, typeof ErrorEnvelopeSchema> {
  const map: Record<number, typeof ErrorEnvelopeSchema> = {};
  for (const status of statuses) {
    map[status] = ErrorEnvelopeSchema;
  }
  return map;
}
