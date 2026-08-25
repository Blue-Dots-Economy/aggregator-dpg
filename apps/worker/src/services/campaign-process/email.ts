/**
 * Campaign email send loop (aggregator-dpg#578).
 *
 * The per-recipient half of the email channel: takes the already-decrypted
 * profile rows, renders the shared Markdown message per recipient (substituting
 * the fixed placeholder set), sends via the injected mailer with bounded
 * concurrency, and reports each recipient's terminal outcome back to the caller
 * — `sent` (with the mailer's message id as the provider ref),
 * `skipped_no_contact` (no email address on the profile) or `failed`.
 *
 * Deliberately free of any job-engine or DB types: the orchestrator in
 * `./index.ts` adapts these callbacks onto the campaign job client, which keeps
 * this loop unit-testable and avoids a circular import. Never logs PII — the
 * per-recipient trace carries the item id and status only, never the resolved
 * address. Belongs to `@aggregator-dpg/worker`.
 */
import type { SignalStackDecryptedProfileRow } from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import { placeholderValues } from '@aggregator-dpg/campaign-template';
import { renderEmail } from '@aggregator-dpg/campaign-template/render';

/** The message the caller submitted (the job row's `content` block). */
export interface EmailTemplate {
  subject: string;
  bodyMarkdown: string;
  replyTo?: string;
}

/** Per-recipient outcome the caller persists as the item's terminal status. */
export type EmailRecipientStatus = 'sent' | 'skipped_no_contact' | 'failed';

/** Injected collaborators — narrow types so the loop is trivially faked. */
export interface EmailSendDeps {
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** How many recipients to send in parallel (`EMAIL_SEND_CONCURRENCY`). */
  concurrency: number;
  /**
   * Records one recipient's terminal outcome. `providerRef` is the mailer's
   * message id, present only on `sent`.
   */
  markRecipient: (
    itemId: string,
    status: EmailRecipientStatus,
    detail?: { reason?: string; providerRef?: string },
  ) => Promise<void>;
  log: { info(obj: object): void };
}

/** Tally of the loop's outcomes, for the caller's summary log. */
export interface EmailSendSummary {
  sent: number;
  skippedNoContact: number;
  failed: number;
}

/**
 * Renders and sends the campaign message to every supplied recipient row.
 *
 * A per-recipient send failure is recorded (`failed`) and does NOT abort the
 * batch — one bad address must not strand the rest. The caller's job roll-up
 * turns a mix into `partial`.
 *
 * @param rows - Decrypted profile rows to email (already ownership-scoped).
 * @param template - Subject / Markdown body / optional Reply-To.
 * @param deps - Mailer, send concurrency, per-recipient reporter, logger.
 * @returns The outcome tally across all recipients.
 */
export async function sendCampaignEmails(
  rows: readonly SignalStackDecryptedProfileRow[],
  template: EmailTemplate,
  deps: EmailSendDeps,
): Promise<EmailSendSummary> {
  const summary: EmailSendSummary = { sent: 0, skippedNoContact: 0, failed: 0 };

  await mapWithConcurrency([...rows], deps.concurrency, async (profile) => {
    const email = profile.contact?.email?.value ?? '';
    let status: EmailRecipientStatus;

    if (!email) {
      // Not a failure: the participant simply has no email address on file.
      summary.skippedNoContact += 1;
      status = 'skipped_no_contact';
      await deps.markRecipient(profile.item_id, status, { reason: 'no_email_address' });
    } else {
      const values = placeholderValues({
        name: profile.contact?.name?.value ?? null,
        email: profile.contact?.email?.value ?? null,
        phone: profile.contact?.phone?.value ?? null,
      });
      const rendered = renderEmail({
        subject: template.subject,
        bodyMarkdown: template.bodyMarkdown,
        values,
      });
      const res = await deps.sendMail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(template.replyTo ? { replyTo: template.replyTo } : {}),
      });
      if (res.ok) {
        summary.sent += 1;
        status = 'sent';
        await deps.markRecipient(profile.item_id, status, { providerRef: res.value.messageId });
      } else {
        summary.failed += 1;
        status = 'failed';
        await deps.markRecipient(profile.item_id, status, {
          reason: `${res.error.code}: ${res.error.message}`,
        });
      }
    }

    // Per-recipient trace — item_id + status only, never the resolved email.
    deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });
  });

  return summary;
}

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!);
    }
  });
  await Promise.all(runners);
}
