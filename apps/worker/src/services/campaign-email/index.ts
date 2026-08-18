/**
 * Participant campaign email orchestrator (aggregator-dpg#578).
 *
 * Decrypts a set of owned participants (only the contact fields the template
 * uses), renders the shared Markdown message per recipient (substituting
 * placeholders), and sends via the injected mailer with bounded concurrency.
 * Runs as the worker's `campaign-email` BullMQ job with send-once semantics
 * (`attempts: 1`) so a retry never duplicates emails.
 *
 * Failure semantics: a decrypt failure or a missing contact block (an older
 * Signals that strips the projection) re-throws so the job is marked failed
 * (nothing was sent). Per-recipient outcomes — sent / skipped-no-email /
 * skipped-not-owned / failed — are counted and logged (counts only, never PII);
 * a per-recipient send failure does NOT fail the job (send-once). Belongs to
 * `@aggregator-dpg/worker`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import {
  requiredContactFields,
  placeholderValues,
  type ContactField,
} from '@aggregator-dpg/campaign-template';
import { renderEmail } from '@aggregator-dpg/campaign-template/render';

/** Job-scoped inputs: item_ids + template from the request; orgId from the token claim. */
export interface EmailParams {
  orgId: string;
  itemIds: string[];
  subject: string;
  bodyMarkdown: string;
  replyTo?: string;
  purpose?: string;
  /** Correlation id (the inbound `x-request-id`), forwarded to Signals decrypt for tracing. */
  requestId?: string;
}

/** Minimal structured logger surface (satisfied by the worker's pino logger). */
export interface EmailLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** Injected collaborators — narrow types so the job is trivially faked. */
export interface EmailDeps {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** How many recipients to send in parallel. */
  concurrency: number;
  log: EmailLogger;
}

type RecipientStatus = 'sent' | 'skipped_no_email' | 'failed';

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

/**
 * Sends one campaign email batch end-to-end (decrypt → render → send).
 *
 * @param params - orgId (Signals org id), itemIds, subject/body templates, optional replyTo/requestId.
 * @param deps - Injected decrypt / mail collaborators, send concurrency, and logger.
 */
export async function runEmailSend(params: EmailParams, deps: EmailDeps): Promise<void> {
  const { orgId, itemIds, subject, bodyMarkdown, replyTo, requestId } = params;
  const start = Date.now();
  const base = { operation: 'campaign.email', org_id: orgId, requested: itemIds.length };

  // Decrypt only what the template needs: the recipient email is always
  // required; name/phone only when a placeholder references them.
  const contact: ContactField[] = [
    ...new Set<ContactField>(['email', ...requiredContactFields(subject, bodyMarkdown)]),
  ];
  const result = await deps.fetchDecryptedProfiles({
    actingOrgId: orgId,
    itemIds,
    fields: [],
    contact,
    ...(requestId ? { requestId } : {}),
  });
  if (!result.success) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'decrypt',
      latency_ms: Date.now() - start,
      error: result.error.message,
      error_type: result.error.code,
    });
    throw new Error(`campaign email decrypt failed: ${result.error.code}: ${result.error.message}`);
  }

  const { profiles, skipped } = result.value;

  if (profiles.length === 0) {
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      sent: 0,
      skipped_not_owned: skipped.length,
    });
    return;
  }

  // Cross-repo contract guard: we requested a contact projection, so resolved
  // rows must carry a contact block. An older Signals that strips it would make
  // every recipient look email-less; fail loud instead of silently sending none.
  if (!profiles.some((p) => p.contact !== undefined)) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'decrypt_contract',
      reason: 'contact_block_absent',
      latency_ms: Date.now() - start,
      resolved: profiles.length,
    });
    throw new Error(
      'campaign email decrypt returned no contact block — Signals participant/decrypt predates #521',
    );
  }

  let sent = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  await mapWithConcurrency(profiles, deps.concurrency, async (profile) => {
    const email = profile.contact?.email?.value ?? '';
    let status: RecipientStatus;
    if (!email) {
      skippedNoEmail += 1;
      status = 'skipped_no_email';
    } else {
      const values = placeholderValues({
        name: profile.contact?.name?.value ?? null,
        email: profile.contact?.email?.value ?? null,
        phone: profile.contact?.phone?.value ?? null,
      });
      const rendered = renderEmail({ subject, bodyMarkdown, values });
      const res = await deps.sendMail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(replyTo ? { replyTo } : {}),
      });
      if (res.ok) {
        sent += 1;
        status = 'sent';
      } else {
        failed += 1;
        status = 'failed';
      }
    }
    // Per-recipient trace — item_id + status only, never the resolved email.
    deps.log.info({ operation: 'campaign.email.recipient', item_id: profile.item_id, status });
  });

  deps.log.info({
    ...base,
    status: failed > 0 ? 'partial' : 'success',
    latency_ms: Date.now() - start,
    sent,
    skipped_no_email: skippedNoEmail,
    skipped_not_owned: skipped.length,
    failed,
  });
}
