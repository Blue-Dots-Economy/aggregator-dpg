/**
 * Shared Fastify route schema for the campaign submit endpoints (#577, #578, #579).
 *
 * The contract spec fixes ONE success envelope for all three channels
 * (§3: `202 { status, requested, job_id, message }`) and one shared error set,
 * so `POST /v1/campaign/{export,email,voice}` declare it from here rather than
 * each keeping its own copy. Only the path, summary, description and `content`
 * shape are per channel — those stay in the route.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';
import { errorResponses } from '../errors/openapi.js';

/**
 * The `202` body every campaign submit endpoint returns. `job_id` is the handle
 * for that channel's poll endpoints; `requested` is the de-duplicated item
 * count, not a promise that every one was acted on.
 */
export const campaignSubmitAcceptedSchema = z.object({
  status: z.literal('queued'),
  requested: z.number().int(),
  job_id: z.string().uuid(),
  message: z.string(),
});

/**
 * The response map shared by the campaign submit endpoints: the `202` above
 * plus the shared error codes (contract spec §4) — schema validation, auth,
 * the org/aggregator gates, both rate limits, and the enqueue failure.
 *
 * @returns A Fastify `schema.response` map, spreadable into a route schema.
 */
export function campaignSubmitResponses() {
  return {
    202: campaignSubmitAcceptedSchema,
    ...errorResponses(400, 401, 403, 429, 503),
  };
}
