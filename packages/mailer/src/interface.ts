/**
 * Mailer contract.
 *
 * Concrete adapters implement the same surface so deployments can choose
 * between vendor-neutral SMTP (MailHog dev, customer SMTP, Postmark, etc.)
 * and AWS SES without touching application code.
 */

/** One file to attach to a message (#551). */
export interface SendAttachment {
  /** Filename shown to the recipient. Must already be sanitised. */
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface SendInput {
  to: string | string[];
  subject: string;
  /** Inline-styled HTML body. Email clients strip <style> tags. */
  html: string;
  /** Plain-text fallback. Required for spam-filter friendliness. */
  text: string;
  /** Override default `from`. Optional. */
  from?: string;
  /** Reply-To header. Optional. */
  replyTo?: string;
  /** CC recipients. Optional. */
  cc?: string | string[];
  /**
   * Files to attach. Optional. Note the transports reach these differently:
   * SMTP hands them to nodemailer directly, while SES has to switch from its
   * simple-content API to raw MIME (see `ses.ts`).
   */
  attachments?: SendAttachment[];
}

export interface SendOk {
  messageId: string;
}

export type MailerResult<T> = { ok: true; value: T } | { ok: false; error: MailerError };

export type MailerError =
  | { code: 'TRANSPORT_FAILED'; message: string }
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'INVALID_RECIPIENT'; message: string };

/** Total attachment bytes on a message, for logging and size checks. */
export function totalAttachmentBytes(attachments: SendAttachment[] | undefined): number {
  return (attachments ?? []).reduce((sum, item) => sum + item.content.byteLength, 0);
}

export abstract class MailerAdapter {
  abstract send(input: SendInput): Promise<MailerResult<SendOk>>;
}
