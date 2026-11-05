/**
 * Zod schemas for the Signals responses that the HTTP writer reads, in the
 * signalstack-writer package. Internal to the package; not a subpath export.
 *
 * Signals serialises each of these replies through its own response schema
 * (`packages/schemas` in signals-dpg). The schemas here require what the
 * writer reads or what the matching interface type promises, and nothing
 * more, so a field Signals adds later does not fail the parse. Objects the
 * api forwards unchanged use `passthrough()` so no field is dropped.
 */

import { z } from 'zod';

/**
 * One item in the onboard and probe responses. Each field is optional
 * because the writer checks the one item it picks and ignores the rest.
 */
const ParticipantItemSchema = z.object({
  item_id: z.string().optional(),
  item_network: z.string().optional(),
  item_domain: z.string().optional(),
  item_type: z.string().optional(),
  lifecycle_status: z.string().nullish(),
});

/** Response from `POST /api/v1/admin/participant` (onboard). */
export const OnboardResponseSchema = z.object({
  user_id: z.string(),
  user_existed: z.boolean().optional(),
  owned_elsewhere: z.boolean().optional(),
  onboarded_at: z.string().nullish(),
  items: z.array(ParticipantItemSchema).optional(),
});

/** Response from `GET /api/v1/admin/participant` (identity probe). */
export const ProbeUserResponseSchema = z.object({
  user_id: z.string().nullish(),
  items: z.array(ParticipantItemSchema),
});

/**
 * Response from `POST /api/v1/admin/aggregator/upsert`. Signals returns
 * `{ org_id, created }`; only `org_id` is read.
 */
export const UpsertAggregatorResponseSchema = z.object({
  org_id: z.string().min(1),
});

/** A map of bucket name to count. Signals omits no bucket, but callers treat a missing one as 0. */
const CountMapSchema = z.record(z.number());

const DashboardRollupSchema = z
  .object({
    total_items: z.number(),
    complete_profiles: z.number(),
    has_applications: z.number(),
    by_status: CountMapSchema,
    by_initiated_action_status: CountMapSchema,
    by_received_action_status: CountMapSchema,
    total_users: z.number(),
    avg_items_per_user: z.number(),
    avg_actions_per_user: z.number(),
    mode_wise_counts: CountMapSchema,
  })
  .passthrough();

const DashboardDomainSliceSchema = z
  .object({
    rollup: DashboardRollupSchema,
    items: z.array(z.record(z.unknown())),
    total_matching: z.number(),
    next_cursor: z.string().nullable(),
  })
  .passthrough();

/** Response from `GET /api/v1/aggregator/dashboard`. */
export const DashboardResponseSchema = z
  .object({
    by_domain: z.record(DashboardDomainSliceSchema),
    metadata: z
      .object({
        last_computed_at: z.string().nullable(),
        ttl_seconds: z.number(),
        refreshed: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const ContactValueSchema = z.object({
  value: z.string().nullable(),
  source: z.enum(['item', 'user']).nullable(),
});

const DecryptedProfileRowSchema = z
  .object({
    item_id: z.string(),
    item_network: z.string(),
    item_domain: z.string(),
    item_type: z.string(),
    item_state: z.record(z.unknown()),
    contact: z
      .object({
        name: ContactValueSchema.optional(),
        email: ContactValueSchema.optional(),
        phone: ContactValueSchema.optional(),
      })
      .optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

/** Response from `POST /api/v1/admin/participant/decrypt`. */
export const DecryptProfilesResponseSchema = z.object({
  profiles: z.array(DecryptedProfileRowSchema),
  skipped: z.array(z.string()),
});

/** One mismatch between a response and its schema: where it is and what kind. */
export interface ResponseIssue {
  /** Dot-separated field path, e.g. `items.0.item_id`. Empty for the root. */
  path: string;
  /** Zod issue code, e.g. `invalid_type`. */
  code: string;
}

/** Upper bound on the issues kept for one bad response, so one malformed list does not make a huge error. */
const MAX_REPORTED_ISSUES = 10;

/**
 * Reduces a Zod error to field paths and issue codes.
 *
 * Zod issue messages can quote the received value, and these responses hold
 * participant data, so the messages are dropped. Never add values here.
 *
 * @returns At most {@link MAX_REPORTED_ISSUES} issues.
 */
export function responseIssues(error: z.ZodError): ResponseIssue[] {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
}
