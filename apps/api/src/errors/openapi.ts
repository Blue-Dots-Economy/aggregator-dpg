/**
 * OpenAPI helpers for the canonical error envelope. Routes spread
 * `errorResponses(...)` into their `schema.response` map so every declared
 * error status documents (and safely serializes) the standard envelope
 * produced by the global error handler.
 */

import { z } from 'zod';

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
