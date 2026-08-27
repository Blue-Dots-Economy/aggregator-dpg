/**
 * Email campaign content validation at the API boundary.
 *
 * The schema itself is shared with the worker
 * (`@aggregator-dpg/campaign-template/content`) so both sides of the channel
 * assert the same thing; this module adds the submit-time placeholder check,
 * which only the API can do usefully — it must fail the request before a job
 * row exists.
 *
 * @module @aggregator-dpg/api
 */
import { unknownPlaceholders } from '@aggregator-dpg/campaign-template';
import { emailContentSchema, type EmailContent } from '@aggregator-dpg/campaign-template/content';
import { httpError } from '../errors/http-error.js';

export { emailContentSchema, type EmailContent };

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
