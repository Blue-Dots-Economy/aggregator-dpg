/**
 * Participant PII export orchestrator (aggregator-dpg#579).
 *
 * Decrypts a set of owned Signals items, writes a CSV to private S3, and emails
 * a short-lived pre-signed download link to the configured network admin. Runs
 * as the worker's `campaign-export` BullMQ job (was an inline fire-and-forget
 * task on the API before 2026-08-11). The export carries only the three
 * canonical contact fields (name/email/phone) with provenance — not item_state.
 * On every *handled* terminal branch (decrypt error, no resolvable items, mail
 * send failure) it logs counts only — never PII — and returns without throwing, so BullMQ does
 * not burn retries on an outcome that will not change. A rejection from an
 * injected collaborator (`putObject` / `signDownloadUrl` decrypt transport)
 * *does* propagate, so the job fails and BullMQ retries it. Belongs to
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

/** Renders the network-admin notification (link only — never the PII itself). */
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
 * @param deps - Injected decrypt / storage / mail collaborators + admin email + logger.
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
    return;
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
    return;
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
