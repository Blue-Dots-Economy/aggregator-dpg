/**
 * Email campaign content schema and placeholder validation.
 *
 * Defines the shape of the email channel's `content` block — the only part of
 * the shared campaign envelope that varies by channel — plus the fail-closed
 * placeholder check that runs before any job row is created.
 *
 * @module @aggregator-dpg/api
 */
import { z } from 'zod';
import { unknownPlaceholders } from '@aggregator-dpg/campaign-template';
import { httpError } from '../errors/http-error.js';

/**
 * Schema for the email campaign request content.
 *
 * Subject and Markdown body are required and length-bounded; `reply_to` is the
 * only caller-settable header (the `From` address is always the aggregator's
 * configured sender). Rejects unknown top-level keys via `.strict()`, so a
 * misspelled field is a client error rather than a silently ignored one.
 */
export const emailContentSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body_markdown: z.string().min(1).max(20000),
    reply_to: z.string().email().optional(),
  })
  .strict();

/** Inferred type from {@link emailContentSchema}. */
export type EmailContent = z.infer<typeof emailContentSchema>;

/**
 * Validates the envelope's raw `content` as an email message.
 *
 * @param rawContent - The envelope's `content` value, unvalidated.
 * @returns The parsed content, ready to persist on the job row.
 * @throws `SCHEMA_VALIDATION` when the block is malformed, or
 *   `UNKNOWN_PLACEHOLDER` when the subject or body references a `{{token}}`
 *   outside the supported set — fail-closed at submit, so a typo never reaches
 *   a real inbox.
 */
export function parseEmailContent(rawContent: unknown): EmailContent {
  const parsed = emailContentSchema.safeParse(rawContent);
  if (!parsed.success) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'content failed email schema validation',
      fields: { issues: parsed.error.issues },
    });
  }

  const unknown = unknownPlaceholders(parsed.data.subject, parsed.data.body_markdown);
  if (unknown.length > 0) {
    throw httpError('UNKNOWN_PLACEHOLDER', { fields: { unknown } });
  }
  return parsed.data;
}
