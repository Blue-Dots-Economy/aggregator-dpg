/**
 * Client-side CSV builder for bulk-selected participant rows. Part of the
 * web app's dashboard bulk-action layer — turns the rows the operator has
 * selected (snapshotted across pages) into an RFC-4180 CSV string, without
 * touching the signalstack-owned full-export endpoint.
 *
 * @module apps/web/services/participant-csv
 */

import type { ParticipantBase } from '../types';

/** Column order of the generated CSV. Header names are stable API surface. */
const COLUMNS = [
  'id',
  'name',
  'joined',
  'profile_completion_pct',
  'lifecycle_status',
  'status',
  'initiated_create',
  'initiated_accept',
  'initiated_reject',
  'initiated_cancel',
  'received_create',
  'received_accept',
  'received_reject',
  'received_cancel',
] as const;

/**
 * Quotes a CSV field per RFC 4180: fields containing a comma, double quote,
 * or line break are wrapped in double quotes with inner quotes doubled.
 *
 * @param value - Raw field value; null/undefined render as an empty field.
 * @returns The escaped field, safe to join with commas.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds a CSV document (header + one line per row) for the given
 * participant rows.
 *
 * Empty input yields just the header line so a downloaded file is never
 * zero-byte/ambiguous. Lines are CRLF-joined per RFC 4180.
 *
 * @param rows - Selected participant rows (any domain — seeker/provider).
 * @returns The full CSV string.
 */
export function buildParticipantCsv(rows: ParticipantBase[]): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.id),
        csvField(r.name),
        csvField(r.joined),
        csvField(r.profile.complete),
        csvField(r.lifecycle_status ?? ''),
        csvField(r.status),
        csvField(r.initiated.create),
        csvField(r.initiated.accept),
        csvField(r.initiated.reject),
        csvField(r.initiated.cancel),
        csvField(r.received.create),
        csvField(r.received.accept),
        csvField(r.received.reject),
        csvField(r.received.cancel),
      ].join(','),
    );
  }
  return lines.join('\r\n');
}
