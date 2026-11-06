/**
 * Display formatters for the dashboard (`web` app).
 */
import { ResponseShapeError } from '@/lib/response-shape-error';

/** Shown in place of a missing value. */
export const EMPTY_VALUE = '—';

/** Initials shown for a row without a usable name. */
const UNKNOWN_INITIALS = '??';

/** Stat values show at most this many decimals (1.1666… → "1.17"). */
const MAX_STAT_DECIMALS = 2;

/** Months are counted as 30 days in the relative "last seen" text. */
const DAYS_PER_MONTH = 30;

/**
 * Formats a numeric stat value in the runtime locale.
 *
 * @param n - The value, possibly missing.
 * @returns The formatted number, or {@link EMPTY_VALUE} when it is missing.
 */
export function fmtCount(n: number | null | undefined): string {
  if (n === undefined || n === null) return EMPTY_VALUE;
  return n.toLocaleString(undefined, { maximumFractionDigits: MAX_STAT_DECIMALS });
}

/**
 * Formats an ISO timestamp as a short relative time ("5m ago", "3d ago").
 *
 * @param iso - The timestamp.
 * @returns The relative text, or {@link EMPTY_VALUE} for an invalid date.
 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EMPTY_VALUE;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < DAYS_PER_MONTH) return `${days}d ago`;
  const months = Math.floor(days / DAYS_PER_MONTH);
  return `${months}mo ago`;
}

/**
 * Returns up to two avatar initials for a name.
 *
 * @param name - Display name; {@link EMPTY_VALUE} counts as no name.
 * @returns The first letters of the first and last words, or the first two
 *   letters of a single word, upper-cased; `'??'` when there is no name.
 */
export function avatarInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === EMPTY_VALUE) return UNKNOWN_INITIALS;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase() || UNKNOWN_INITIALS;
  const last = parts[parts.length - 1] ?? '';
  const initials = (first.charAt(0) + last.charAt(0)).toUpperCase();
  return initials || UNKNOWN_INITIALS;
}

/**
 * Text to show for a failed dashboard call.
 *
 * @param err - The failure.
 * @param unreadable - The message for a reply that could not be read.
 * @param fallback - The message when the failure is not an `Error`.
 * @returns A plain message for an unreadable reply, else the error's own message.
 */
export function failureText(err: unknown, unreadable: string, fallback: string): string {
  if (err instanceof ResponseShapeError) return unreadable;
  return err instanceof Error ? err.message : fallback;
}
