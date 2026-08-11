/**
 * Participant PII export orchestrator (aggregator-dpg#579).
 *
 * Decrypts a set of owned Signals items, writes a CSV to private S3, and emails
 * a short-lived pre-signed download link to the requesting aggregator. Runs
 * as the worker's `campaign-export` BullMQ job (was an inline fire-and-forget
 * task on the API before 2026-08-11). The export carries only the three
 * canonical contact fields (name/email/phone) with provenance — not item_state.
 *
 * Failure semantics (BullMQ retry-aware): transient/infra failures re-throw so
 * BullMQ counts the attempt and retries per `DEFAULT_JOB_OPTS` (3× exponential)
 * — a decrypt error (the writer returns `err()`, never throws, on
 * timeout/transport/upstream-5xx), a missing `contact` block (an older Signals
 * predating #521 that strips the projection), an S3 put/sign rejection, and a
 * mail-send failure. A 202-acknowledged export must never be silently dropped.
 * The one terminal, non-retried branch is "no resolvable items" (nothing owned
 * to export): logged (counts only, never PII) and returned. Never logs PII.
 * The decrypted CSV is written under `campaign-exports/{orgId}/` in the shared
 * bucket; its retention is an external S3 lifecycle rule on that prefix (the
 * worker never deletes S3 objects — see `cron-watchdog.ts`). Belongs to
 * `@aggregator-dpg/worker`.
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import type {
  SignalStackFetchDecryptedProfilesQuery,
  SignalStackDecryptedProfiles,
} from '@aggregator-dpg/signalstack-writer/interface';
import type { SendInput, SendOk, MailerResult } from '@aggregator-dpg/mailer/interface';
import type { SignedDownloadUrl } from '../../object-storage.js';
import { buildContactExportCsv } from '@aggregator-dpg/profile-csv';

/** Job-scoped inputs: item_ids/purpose from the request; orgId from the token's `signalstack_org_id` claim. */
export interface ExportParams {
  orgId: string;
  itemIds: string[];
  purpose?: string;
  /** Correlation id (the inbound `x-request-id`), forwarded to Signals decrypt for tracing. */
  requestId?: string;
}

/** Minimal structured logger surface (satisfied by the worker's pino logger). */
export interface ExportLogger {
  info(obj: object): void;
  warn(obj: object): void;
  error(obj: object): void;
}

/** Injected collaborators — narrow function types so the job is trivially faked. */
export interface ExportDeps {
  fetchDecryptedProfiles: (
    q: SignalStackFetchDecryptedProfilesQuery,
  ) => Promise<Result<SignalStackDecryptedProfiles, BaseError>>;
  putObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  signDownloadUrl: (key: string) => Promise<SignedDownloadUrl>;
  sendMail: (input: SendInput) => Promise<MailerResult<SendOk>>;
  /** The requesting aggregator's contact email (resolved by the API before enqueue). */
  recipientEmail: string;
  log: ExportLogger;
}

interface ExportEmailInput {
  orgId: string;
  purpose: string;
  exported: number;
  skipped: number;
  url: string;
  expiresAt: string;
}

/** Escapes the few HTML metacharacters that can appear in org id / purpose. */
function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Renders the export-ready notification (link only — never the PII itself). */
function renderExportEmail(i: ExportEmailInput): { subject: string; html: string; text: string } {
  const subject = `PII export ready — ${i.exported} records`;
  const text = [
    'A participant PII export is ready.',
    '',
    `Requested by org: ${i.orgId}`,
    `Purpose: ${i.purpose}`,
    `Records exported: ${i.exported}`,
    `Skipped (not found / not owned): ${i.skipped}`,
    '',
    `Download (expires ${i.expiresAt}):`,
    i.url,
    '',
    'This link is time-limited and the file contains personal data. Do not forward it.',
  ].join('\n');
  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">',
    '<p>A participant PII export is ready.</p>',
    '<ul>',
    `<li>Requested by org: <strong>${esc(i.orgId)}</strong></li>`,
    `<li>Purpose: ${esc(i.purpose)}</li>`,
    `<li>Records exported: <strong>${i.exported}</strong></li>`,
    `<li>Skipped (not found / not owned): <strong>${i.skipped}</strong></li>`,
    '</ul>',
    `<p><a href="${esc(i.url)}">Download the export</a> (expires ${esc(i.expiresAt)}).</p>`,
    '<p style="color:#a00">This link is time-limited and the file contains personal data. Do not forward it.</p>',
    '</div>',
  ].join('');
  return { subject, html, text };
}

/**
 * Runs one export end-to-end (decrypt → CSV → S3 → email link).
 *
 * @param params - orgId (Signals org id), itemIds, optional purpose + requestId.
 * @param deps - Injected decrypt / storage / mail collaborators + recipient email + logger.
 */
export async function runExport(params: ExportParams, deps: ExportDeps): Promise<void> {
  const { orgId, itemIds, purpose, requestId } = params;
  const start = Date.now();
  const base = { operation: 'campaign.export', org_id: orgId, requested: itemIds.length };

  // Contact-only decrypt: no item_state (`fields: []`), just the canonical
  // name/email/phone with provenance (Signals #521).
  const result = await deps.fetchDecryptedProfiles({
    actingOrgId: orgId,
    itemIds,
    fields: [],
    contact: ['name', 'email', 'phone'],
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
    // The writer returns err() (never throws) on a transient upstream failure
    // — timeout / transport / 5xx. Re-throw so BullMQ counts the attempt and
    // retries; a log-and-return here would mark the job complete and silently
    // drop a 202-acknowledged export.
    throw new Error(
      `campaign export decrypt failed: ${result.error.code}: ${result.error.message}`,
    );
  }

  const { profiles, skipped } = result.value;

  if (profiles.length === 0) {
    deps.log.warn({
      ...base,
      status: 'skipped',
      reason: 'no_resolvable_items',
      latency_ms: Date.now() - start,
      exported: 0,
      skipped: skipped.length,
    });
    return;
  }

  // Cross-repo contract guard (Signals #521): we requested a contact-only
  // projection, so every resolved row must carry a `contact` block. A Signals
  // that predates #521 silently strips the `contact`/`fields` keys and returns
  // full item_state with no contact — which would otherwise be emailed as an
  // all-empty "Records exported: N" CSV. Fail loud (and let BullMQ retry, in
  // case Signals is mid-upgrade) instead of shipping a misleading empty export.
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
      'campaign export decrypt returned no contact block — Signals participant/decrypt predates #521',
    );
  }

  // Only the three fixed contact columns are exported, so the schema is stable
  // regardless of item type/domain — no homogeneity check needed.
  const csv = buildContactExportCsv(profiles);
  const key = `campaign-exports/${orgId}/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

  await deps.putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
  const signed = await deps.signDownloadUrl(key);

  const email = renderExportEmail({
    orgId,
    purpose: purpose?.trim() ? purpose : '—',
    exported: profiles.length,
    skipped: skipped.length,
    url: signed.url,
    expiresAt: signed.expiresAt,
  });

  const sent = await deps.sendMail({
    to: deps.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!sent.ok) {
    deps.log.error({
      ...base,
      status: 'failure',
      step: 'email',
      latency_ms: Date.now() - start,
      error: sent.error.message,
      error_type: sent.error.code,
      s3_key: key,
    });
    // Re-throw so BullMQ retries the send. The CSV is already durably in S3; a
    // retry re-decrypts + re-uploads (new timestamped key) + re-sends. A
    // log-and-return would mark the job complete and drop the notification,
    // leaving the caller's 202 unfulfilled with no link ever delivered.
    throw new Error(`campaign export email failed: ${sent.error.code}: ${sent.error.message}`);
  }

  deps.log.info({
    ...base,
    status: 'success',
    latency_ms: Date.now() - start,
    exported: profiles.length,
    skipped: skipped.length,
    s3_key: key,
  });
}
