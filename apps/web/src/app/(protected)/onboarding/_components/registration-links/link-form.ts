/**
 * Pure helpers for the registration link forms: field values, slug and title
 * derivation, tag parsing, and reading link `context` values (web app).
 */

/** Fields the create form and the draft edit form share. */
export interface LinkFormFields {
  /** Instance (state of operation). Drives slug + display title. */
  state: string;
  /** District. Required. Drives slug + display title. */
  district: string;
  /** Free-form lever / event label (e.g. "Field Drive", "Campaign"). */
  lever_event: string;
  /** ISO date string (yyyy-mm-dd) for the event. */
  event_date: string;
  /** Optional event venue / city. */
  event_location: string;
  /** Optional, comma-separated free-form tags. Stored on `context.tags`. */
  tags: string;
}

/** Values of the create form. */
export interface CreateLinkFormValues extends LinkFormFields {
  /**
   * Registration mode key from the network config's `registration_modes`.
   *
   * Set at create time and cannot change. Empty until the config loads.
   */
  registration_mode: string;
}

/** The fields a slug and a title are built from. */
type SlugFields = Pick<LinkFormFields, 'district' | 'lever_event' | 'event_date'>;

/** Longest slug part taken from one field, so a slug stays readable in a URL. */
const SLUG_PART_MAX_LENGTH = 40;

/** Splits a comma-separated tags input into a trimmed, de-duped, non-empty list. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

function slugifyForLink(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SLUG_PART_MAX_LENGTH);
}

/**
 * Builds `<district>-<event>[-<monYY>]` for a link.
 *
 * @returns The slug, or `undefined` when the district or event slugifies to nothing.
 */
export function buildLinkSlug(f: SlugFields): string | undefined {
  const district = slugifyForLink(f.district);
  const lever = slugifyForLink(f.lever_event);
  if (!district || !lever) return undefined;
  let dateSuffix = '';
  if (f.event_date) {
    const d = new Date(f.event_date);
    if (!Number.isNaN(d.getTime())) {
      const mon = d.toLocaleString('en-US', { month: 'short' }).toLowerCase();
      const yy = String(d.getFullYear()).slice(-2);
      dateSuffix = `-${mon}${yy}`;
    }
  }
  return `${district}-${lever}${dateSuffix}`;
}

/** Builds the display title `<district> <event> — <Mon YYYY>` for a link. */
export function buildLinkTitle(f: SlugFields): string {
  const parts = [f.district, f.lever_event].filter(Boolean).join(' ');
  if (!f.event_date) return parts || 'Untitled link';
  const d = new Date(f.event_date);
  if (Number.isNaN(d.getTime())) return parts;
  const monYear = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  return parts ? `${parts} — ${monYear}` : monYear;
}

/**
 * Splits a public URL into `{ host, path }` for display.
 *
 * Returns empty parts for a null URL. A malformed URL is returned as the host.
 */
export function splitPublicUrl(publicUrl: string | null): { host: string; path: string } {
  if (!publicUrl) return { host: '', path: '' };
  try {
    const u = new URL(publicUrl);
    return { host: u.host, path: u.pathname.replace(/^\//, '') };
  } catch {
    return { host: publicUrl, path: '' };
  }
}

/** Reads a string value from a link's `context`; `''` when absent or not a string. */
export function contextString(ctx: Record<string, unknown>, key: string): string {
  const value = ctx[key];
  return typeof value === 'string' ? value : '';
}

/** Reads `context.tags` as the comma-separated text the tags input shows. */
export function contextTagsText(ctx: Record<string, unknown>): string {
  const tags = ctx['tags'];
  if (!Array.isArray(tags)) return '';
  return tags.filter((tag): tag is string => typeof tag === 'string').join(', ');
}

/** The message to show for a failed create or save. */
export function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
