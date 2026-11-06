/**
 * Readable text for bulk-upload statuses and worker failure reasons
 * (`apps/web`), so the uploads table never shows a machine code.
 *
 * @module apps/web/src/lib/bulk-upload-text
 */

/** A `next-intl` translator scoped to `onboarding.csv.recent`. */
export type RecentTranslator = ((key: string, values?: Record<string, string>) => string) & {
  has: (key: string) => boolean;
};

/** `processing_stuck` → `Processing stuck`. */
export function humaniseCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** `a,b` → `a, b`. */
function listOf(detail: string): string {
  return detail
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Turns a worker `status_reason` (`code` or `code: detail`) into a sentence.
 *
 * @param reason - The upload's `status_reason`.
 * @param t - Translator for `onboarding.csv.recent`.
 * @returns A readable sentence; unknown codes are humanised.
 */
export function bulkReasonText(reason: string, t: RecentTranslator): string {
  const sep = reason.indexOf(':');
  const code = (sep === -1 ? reason : reason.slice(0, sep)).trim();
  const detail = sep === -1 ? '' : reason.slice(sep + 1).trim();
  if (code === 'header_mismatch') {
    const m = /^(missing|unknown):(.*)$/.exec(detail);
    if (m) return t(`reason.header_${m[1]}`, { columns: listOf((m[2] ?? '').trim()) });
  }
  const key = `reason.${code}`;
  if (/^[a-z_]+$/.test(code) && t.has(key)) return t(key);
  return humaniseCode(code);
}

/**
 * Readable label for an upload status.
 *
 * @param status - The upload's `status`.
 * @param t - Translator for `onboarding.csv.recent`.
 * @returns The translated label, or the humanised code.
 */
export function bulkStatusText(status: string, t: RecentTranslator): string {
  const key = `status.${status}`;
  return /^[a-z_]+$/.test(status) && t.has(key) ? t(key) : humaniseCode(status);
}
