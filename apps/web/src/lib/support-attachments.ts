/**
 * Client-side half of the support-attachment rules (#551).
 *
 * The API validates everything again — this exists so a coordinator learns a
 * file is too big or the wrong type before spending time uploading it. Mirrors
 * signals-dpg's `apps/ui/src/lib/support-attachments.ts`; change both together.
 *
 * @module apps/web/src/lib/support-attachments
 */

/** What the instance allows, as served by `GET /api/support/config`. */
export interface SupportConfig {
  enabled: boolean;
  maxTotalBytes: number;
  maxFiles: number;
  allowedTypes: string[];
  /**
   * Extensions for the picker's `accept`, served alongside the MIME list because
   * macOS won't match `.m4a` against `audio/mp4` and greys it out. Optional so a
   * web build still works against an older API.
   */
  allowedExtensions?: string[];
}

/** One attachment in the request payload. */
export interface SupportAttachmentPayload {
  filename: string;
  contentType: string;
  /** Base64 without the `data:` prefix. */
  data: string;
}

/** Rejection reasons; the caller maps these to translated messages. */
export type AttachmentRejection =
  { reason: 'count' } | { reason: 'size' } | { reason: 'type'; filename: string };

export type AttachmentSelectionResult =
  { ok: true; files: File[] } | ({ ok: false } & AttachmentRejection);

/**
 * Used while the config request is in flight or if it fails: mirrors the API's
 * defaults so the picker stays usable — an over-limit file is still refused
 * server-side with a specific error.
 */
export const SUPPORT_CONFIG_FALLBACK: SupportConfig = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/*', 'video/*', 'audio/*'],
  allowedExtensions: [],
};

/**
 * Formats a byte count the same way the API does, so both messages read alike.
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
 * The `accept` attribute for the picker: MIME types *and* extensions.
 *
 * Types alone leave real files unselectable — macOS resolves `accept` through
 * its UTI table, which doesn't map `.m4a` (an iPhone voice memo) onto
 * `audio/mp4`, so the file shows up greyed out. Extensions are matched
 * literally, so listing both makes the picker agree with the API.
 *
 * @param config - Limits currently served by the API.
 * @returns A comma-separated `accept` value.
 */
export function pickerAccept(
  config: Pick<SupportConfig, 'allowedTypes' | 'allowedExtensions'>,
): string {
  return [...config.allowedTypes, ...(config.allowedExtensions ?? [])].join(',');
}

/**
 * Whether a file's type is accepted. Handles exact types (`image/png`, what the
 * API serves) and `type/*` wildcards (used by the offline fallback).
 *
 * @param fileType - The browser-reported MIME type.
 * @param allowedTypes - Accepted types, exact or wildcard.
 * @returns True when the file may be attached.
 */
export function matchesAllowedType(fileType: string, allowedTypes: string[]): boolean {
  const type = fileType.trim().toLowerCase();
  if (!type) return false;
  return allowedTypes.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    if (candidate === type) return true;
    if (!candidate.endsWith('/*')) return false;
    return type.startsWith(candidate.slice(0, -1));
  });
}

/**
 * Validates what the picker would add to the current selection. Checked against
 * the combined list, since the limits are per submission. Order matches the
 * API: count, then type, then total size.
 *
 * @param current - Files already chosen.
 * @param incoming - Files just picked.
 * @param config - The instance's limits.
 * @returns The merged selection, or the rejection to report.
 */
export function validateAttachmentSelection(
  current: File[],
  incoming: File[],
  config: Pick<SupportConfig, 'maxFiles' | 'maxTotalBytes' | 'allowedTypes'>,
): AttachmentSelectionResult {
  const files = [...current, ...incoming];
  if (files.length > config.maxFiles) return { ok: false, reason: 'count' };

  for (const file of incoming) {
    if (!matchesAllowedType(file.type, config.allowedTypes)) {
      return { ok: false, reason: 'type', filename: file.name };
    }
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > config.maxTotalBytes) return { ok: false, reason: 'size' };

  return { ok: true, files };
}

/**
 * Base64-encodes a file for the JSON body. Chunked because spreading a
 * multi-megabyte byte array into `String.fromCodePoint` arguments overflows the
 * call stack. Every byte is 0–255, so code points and char codes coincide here.
 *
 * @param file - The file to encode.
 * @returns Base64 string without a `data:` prefix.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Encodes the selection into the request payload shape.
 *
 * @param files - The chosen files.
 * @returns Payload entries, in the same order.
 */
export async function encodeAttachments(files: File[]): Promise<SupportAttachmentPayload[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      // Browsers leave `type` empty for some files; the API's allowlist rejects
      // an empty type, so send something concrete it can judge.
      contentType: file.type || 'application/octet-stream',
      data: await fileToBase64(file),
    })),
  );
}
