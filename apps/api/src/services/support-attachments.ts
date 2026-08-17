/**
 * Support-form attachment policy (#551): what may be attached to a
 * complaint/support submission, and how big it may be.
 *
 * Deliberately a mirror of signals-dpg's `apps/api/src/support/attachments.ts`
 * — the two products expose the same form and must accept exactly the same
 * files, but they share no runtime package, so the rules are duplicated rather
 * than imported. Change both together.
 *
 * Pure (limits passed in), so every rejection path is unit-testable without a
 * Fastify instance. Belongs to `@aggregator-dpg/api`.
 */

/** One attachment as it arrives on the wire. */
export interface SupportAttachmentInput {
  filename: string;
  contentType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export type SupportAttachmentErrorCode =
  | 'ATTACHMENT_COUNT_EXCEEDED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TYPE_NOT_ALLOWED'
  | 'ATTACHMENT_INVALID_ENCODING';

export interface AcceptedSupportAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  bytes: number;
}

export type SupportAttachmentResult =
  | { ok: true; attachments: AcceptedSupportAttachment[] }
  | { ok: false; error: SupportAttachmentErrorCode; detail: string };

/**
 * Content types the support form accepts.
 *
 * Scope, so nobody mistakes this for more than it is: `contentType` is declared
 * by the client and never checked against the bytes, so this rejects an honest
 * mistake (a PDF, a zip) but not a renamed executable sent with
 * `contentType: image/png`. It is a UX filter, and the support mailbox must
 * still scan what it receives — see SETUP.md.
 *
 * Kept in code rather than in env because the list is a product decision about
 * what the form is for, not a per-deployment knob; adding a legitimate format is
 * a one-line change here that the web form picks up automatically (it reads this
 * list from `GET /v1/support/config`).
 *
 * The phone-produced formats are deliberate: iPhones hand out HEIC photos and
 * `.m4a` voice memos, and Android cameras/voice recorders produce 3GPP and AMR.
 *
 * Note the `x-` variants. A browser picks the type from its own extension table,
 * not from the file: Chrome reports `audio/x-m4a` for a `.m4a` (an iPhone voice
 * memo, the commonest voice attachment there is) even though the container is
 * MPEG-4 audio. Listing only the canonical `audio/mp4` rejected those.
 */
export const SUPPORT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/x-m4v',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/3gpp',
  'audio/amr',
];

/**
 * Extensions for the file picker's `accept` attribute, alongside the MIME list.
 *
 * MIME types alone are not enough: macOS maps `accept="audio/mp4"` through its
 * own UTI table, which does not claim `.m4a`, so a voice memo shows up greyed
 * out in the picker even though the API would accept it. Extensions are matched
 * literally by the browser and close that gap. They are a picker hint only —
 * validation stays MIME-based on both sides.
 */
export const SUPPORT_ALLOWED_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.3gp',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.amr',
];

const MAX_FILENAME_LENGTH = 120;

/**
 * Base64 alphabet plus optional padding. Deliberately a single character class
 * with no grouped quantifier: the obvious RFC-4648 pattern
 * (`^(?:[A-Za-z0-9+/]{4})*(?:..[AEIMQUYcgkosw048]=|...)?$`) has to backtrack over
 * every 4-char group when the tail fails to match, and on a max-legal 5 MB
 * attachment that overflowed V8's regex stack — a valid submission became a 500.
 * This form is linear in the input, so a 7 MB string costs the same whether it
 * passes or fails.
 *
 * `length % 4` carries the rest of the rule (the grouped pattern got that from
 * its `{4}` repetition). Together they accept exactly what the notification
 * service's `z.base64()` accepts — verified by differential comparison — so this
 * side can never wave through a payload the relay will reject.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strips whitespace and checks the result really is base64.
 *
 * Worth doing rather than trusting the decoder: `Buffer.from(x, 'base64')`
 * silently ignores anything outside the alphabet, so a `data:` URL prefix, a
 * truncated upload or binary noise decodes to garbage and is mailed as a corrupt
 * file with no error raised anywhere. Wrapped base64 (newlines every 76 chars)
 * is legitimate, so it is compacted rather than rejected.
 *
 * @param data - Raw `data` value as submitted.
 * @returns The compacted base64, or null when it is not base64 at all.
 */
export function normaliseBase64(data: string): string | null {
  const compact = data.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
  return compact;
}

/**
 * Decoded byte length of a base64 string without decoding it, so an oversized
 * payload is rejected before it costs a Buffer allocation.
 *
 * @param data - Base64 string, optionally containing whitespace.
 * @returns Decoded size in bytes.
 */
export function decodedBase64Length(data: string): number {
  const compact = data.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  return Math.floor((compact.length * 3) / 4) - base64Padding(compact);
}

/**
 * Counts the `=` padding characters at the end of a base64 string.
 *
 * @param compact - Whitespace-free base64.
 * @returns 0, 1 or 2.
 */
function base64Padding(compact: string): number {
  if (compact.endsWith('==')) return 2;
  if (compact.endsWith('=')) return 1;
  return 0;
}

/**
 * Makes a client-supplied filename safe for a MIME header and for a support
 * agent's inbox: drops any directory component, strips control characters and
 * quotes (which could break out of the `filename="..."` parameter), collapses
 * whitespace, and caps the length.
 *
 * @param filename - Raw filename from the client.
 * @returns A safe filename; `attachment` when nothing usable remains.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * Human-readable size for the email's attachment listing and error messages.
 *
 * @param bytes - Size in bytes.
 * @returns e.g. `512 B`, `2.0 KB`, `5.0 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validates a submitted attachment list against the instance's limits and
 * decodes what it accepts.
 *
 * Order is count → type → total size, so the message names the first thing the
 * submitter can act on rather than a consequence of it.
 *
 * @param attachments - Submitted attachments, if any.
 * @param limits - Configured maximum file count and total decoded bytes.
 * @returns The decoded attachments, or the rejection to reply with.
 */
export function validateSupportAttachments(
  attachments: SupportAttachmentInput[] | undefined,
  limits: { maxFiles: number; maxTotalBytes: number },
): SupportAttachmentResult {
  const list = attachments ?? [];
  if (list.length === 0) return { ok: true, attachments: [] };

  if (list.length > limits.maxFiles) {
    return {
      ok: false,
      error: 'ATTACHMENT_COUNT_EXCEEDED',
      detail: `Attach at most ${limits.maxFiles} file${limits.maxFiles === 1 ? '' : 's'}.`,
    };
  }

  let totalBytes = 0;
  // Holds the whitespace-compacted, validated base64 per item so the decode
  // below works from the checked string rather than the raw input.
  const normalised: string[] = [];
  for (const item of list) {
    const contentType = item.contentType.trim().toLowerCase();
    if (!SUPPORT_ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return {
        ok: false,
        error: 'ATTACHMENT_TYPE_NOT_ALLOWED',
        detail: `${sanitizeFilename(item.filename)} is not an accepted file type. Attach an image, video or audio file.`,
      };
    }
    // Checked, not assumed: `Buffer.from(x, 'base64')` ignores anything outside
    // the alphabet, so an unvalidated payload (a `data:` prefix, a truncated
    // upload) decodes to garbage and is mailed as a corrupt file with no error
    // raised anywhere.
    const data = normaliseBase64(item.data);
    if (!data) {
      return {
        ok: false,
        error: 'ATTACHMENT_INVALID_ENCODING',
        detail: `${sanitizeFilename(item.filename)} could not be read. Please attach the file again.`,
      };
    }
    normalised.push(data);
    totalBytes += decodedBase64Length(data);
  }

  if (totalBytes > limits.maxTotalBytes) {
    return {
      ok: false,
      error: 'ATTACHMENT_TOO_LARGE',
      detail: `Attachments must total no more than ${formatBytes(limits.maxTotalBytes)}.`,
    };
  }

  // Decoded only after every bound passes, so a rejected submission never
  // allocates buffers for its payload.
  const accepted = list.map((item, index) => {
    const content = Buffer.from(normalised[index]!, 'base64');
    return {
      filename: sanitizeFilename(item.filename),
      contentType: item.contentType.trim().toLowerCase(),
      content,
      bytes: content.byteLength,
    };
  });

  return { ok: true, attachments: accepted };
}

/** Envelope headroom over the base64-inflated attachment budget. */
const ENVELOPE_HEADROOM_BYTES = 256 * 1024;

/**
 * HTTP body limit implied by an attachment budget: base64 inflates the payload
 * by 4/3 and the JSON envelope carries the rest of the form on top. Derived
 * rather than hardcoded so raising `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` cannot
 * turn into a silent 413.
 *
 * @param maxTotalBytes - Configured total decoded attachment budget.
 * @returns Body limit in bytes.
 */
export function supportBodyLimitBytes(maxTotalBytes: number): number {
  return Math.ceil((maxTotalBytes * 4) / 3) + ENVELOPE_HEADROOM_BYTES;
}
