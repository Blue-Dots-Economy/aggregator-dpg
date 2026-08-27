/**
 * The email channel's message contract (aggregator-dpg#578).
 *
 * One schema, shared by both sides of the channel: the API validates the
 * inbound `content` block against it before a job row exists, and the worker
 * re-validates the persisted row against the SAME schema before rendering. It
 * lives here rather than in either app because `apps/*` cannot import from each
 * other, and two copies would drift — the worker's used to be looser (no
 * `.email()`, no length caps, not `.strict()`), which meant it did not actually
 * re-assert what the API had guaranteed.
 *
 * Belongs to `@aggregator-dpg/campaign-template`.
 */
import { z } from 'zod';

/** Max characters allowed in the subject line. */
export const SUBJECT_MAX = 200;

/** Max characters allowed in the Markdown body. */
export const BODY_MAX = 20000;

/**
 * The email channel's `content` block.
 *
 * `reply_to` is the only caller-settable header (the `From` address is always
 * the aggregator's configured sender). Strict: an unknown key is a client
 * error, not a silently ignored field.
 */
export const emailContentSchema = z
  .object({
    subject: z.string().trim().min(1).max(SUBJECT_MAX),
    body_markdown: z.string().min(1).max(BODY_MAX),
    reply_to: z.string().email().optional(),
  })
  .strict();

/** Inferred type from {@link emailContentSchema}. */
export type EmailContent = z.infer<typeof emailContentSchema>;
