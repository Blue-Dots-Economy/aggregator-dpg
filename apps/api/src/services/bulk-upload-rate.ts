/**
 * Injectable rate-limit checks for the bulk-upload surface.
 *
 * Mirrors `support-rate.ts`: wraps the Redis fixed-window limiter so route tests
 * can vary the outcome without Redis (the real limiter fails open, so an
 * un-overridden test would always see "allowed" and the 429 path would be
 * untestable).
 *
 * Two buckets rather than one. They guard different costs: an upload accepts a
 * multi-MB file and persists it, while a template request builds a four-tab
 * xlsx workbook per call. Sharing a bucket would either throttle template
 * downloads to upload frequency or let template traffic exhaust the upload
 * allowance.
 *
 * Belongs to `@aggregator-dpg/api`.
 */

import { consume } from './rate-limiter/index.js';

/**
 * Uploads allowed per coordinator per window. Matched to `support-rate.ts`,
 * which guards the other multi-MB upload path in this service.
 */
export const BULK_UPLOAD_RATE_WINDOW_SECONDS = 3600;
export const BULK_UPLOAD_RATE_MAX_PER_WINDOW = 5;

/**
 * Template builds allowed per coordinator per window. More permissive than the
 * upload bucket — fetching a template is a normal precursor to filling one in,
 * and a coordinator may legitimately pull both participant types in both
 * formats — but still bounded, because each call renders a workbook.
 */
export const BULK_TEMPLATE_RATE_WINDOW_SECONDS = 3600;
export const BULK_TEMPLATE_RATE_MAX_PER_WINDOW = 30;

export interface BulkUploadRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<BulkUploadRateResult>;

let uploadOverride: Checker | null = null;
let templateOverride: Checker | null = null;

/** Test helper — replace the upload checker (null restores the Redis-backed default). */
export function _setBulkUploadRateChecker(c: Checker | null): void {
  uploadOverride = c;
}

/** Test helper — replace the template checker (null restores the Redis-backed default). */
export function _setBulkTemplateRateChecker(c: Checker | null): void {
  templateOverride = c;
}

/**
 * Consumes one slot for the given key from the bulk-upload bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the upload is allowed + retry-after seconds.
 */
export async function checkBulkUploadRate(key: string): Promise<BulkUploadRateResult> {
  if (uploadOverride) return uploadOverride(key);
  const r = await consume({
    namespace: 'bulk-upload',
    key,
    windowSeconds: BULK_UPLOAD_RATE_WINDOW_SECONDS,
    max: BULK_UPLOAD_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}

/**
 * Consumes one slot for the given key from the bulk-template bucket.
 *
 * @param key - Identifier inside the bucket (the authenticated user id).
 * @returns Whether the template build is allowed + retry-after seconds.
 */
export async function checkBulkTemplateRate(key: string): Promise<BulkUploadRateResult> {
  if (templateOverride) return templateOverride(key);
  const r = await consume({
    namespace: 'bulk-template',
    key,
    windowSeconds: BULK_TEMPLATE_RATE_WINDOW_SECONDS,
    max: BULK_TEMPLATE_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
