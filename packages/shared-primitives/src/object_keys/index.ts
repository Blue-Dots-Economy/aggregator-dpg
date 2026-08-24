/**
 * Object-storage key layout, shared by every process that touches the bucket.
 *
 * The bucket is private: nothing is reachable without a pre-signed URL. These
 * builders are the single definition of where an object lives, and they exist
 * in a shared package for two reasons:
 *
 *   1. The worker WRITES the errors CSV while the api VALIDATES the key it is
 *      asked to presign against the same layout. Two copies of that string
 *      would drift, and the drift would present as "download is broken".
 *   2. Retention is enforced by S3 lifecycle rules keyed on PREFIX, so the
 *      prefixes below are an infrastructure contract, not an internal detail.
 *      `uploads/raw/` and `uploads/errors/` expire on different schedules and
 *      must stay disjoint; `qr/` is durable and must never carry an
 *      expiration rule.
 *
 * @module @aggregator-dpg/shared-primitives
 */

/** Transient: raw participant CSVs. Shortest retention — highest-PII object. */
export const BULK_UPLOAD_RAW_PREFIX = 'uploads/raw/';

/** Transient: generated error reports. Longer retention than the raw CSV. */
export const BULK_UPLOAD_ERRORS_PREFIX = 'uploads/errors/';

/** Durable: registration-link QR PNGs. A printed QR outlives any TTL. */
export const QR_PREFIX = 'qr/';

/**
 * Pre-migration errors-CSV prefix, kept only so rows written before the key
 * move still resolve. Objects under it are covered by their own lifecycle rule
 * and this constant can be retired once that window has elapsed.
 */
const LEGACY_BULK_UPLOAD_PREFIX = 'bulk-uploads/';

/**
 * Characters permitted in a key segment.
 *
 * A positive allow-list, deliberately: every caller passes a UUID from the
 * database or a verified session claim, so the accepted alphabet is known and
 * narrow. A denylist of "dangerous" characters is the weaker construction — it
 * has to enumerate separators, traversals, control characters, percent-encoded
 * separators, unicode line separators and length limits, and it silently admits
 * whatever the next reviewer forgets.
 *
 * 64 characters is comfortably above a UUID (36) while staying far under S3's
 * 1024-byte key limit, so an over-long id fails here rather than as a
 * `KeyTooLongError` from S3 at request time.
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Rejects any id that would change the meaning of the key it is interpolated
 * into.
 *
 * Interpolating unvalidated input into an object key is a path-traversal
 * primitive: a `..` segment walks out of the tenant prefix, and the api's
 * signing allow-list is built from these same functions — so a traversal here
 * becomes "mint a pre-signed URL for somebody else's object". Every caller
 * passes a UUID from the database or a verified session, so a violation means
 * a programming error, not bad user input: throw rather than sanitise, so it
 * surfaces at the call site instead of silently addressing the wrong object.
 *
 * @param value - Candidate key segment (an aggregator, upload, or link id).
 * @param name - Parameter name, echoed in the error so the caller is findable.
 * @returns `value` unchanged when it is safe to interpolate.
 * @throws If `value` is not 1-64 characters of `[A-Za-z0-9_-]`.
 */
function assertKeySegment(value: string, name: string): string {
  if (!KEY_SEGMENT_PATTERN.test(value)) {
    throw new Error(
      `Invalid object key segment for '${name}': must be 1-64 characters of [A-Za-z0-9_-].`,
    );
  }
  return value;
}

/**
 * Key of the raw CSV a browser uploads via pre-signed PUT.
 *
 * @param aggregatorId - Owning aggregator; the tenant prefix segment.
 * @param uploadId - `bulk_uploads.id`, making the key deterministic per upload.
 */
export function bulkUploadRawKey(aggregatorId: string, uploadId: string): string {
  const agg = assertKeySegment(aggregatorId, 'aggregatorId');
  const upload = assertKeySegment(uploadId, 'uploadId');
  return `${BULK_UPLOAD_RAW_PREFIX}${agg}/${upload}.csv`;
}

/**
 * Key of the generated errors CSV for an upload.
 *
 * @param aggregatorId - Owning aggregator; the tenant prefix segment.
 * @param uploadId - `bulk_uploads.id`. Deterministic so a retried finalise
 *   overwrites identical bytes instead of orphaning a second object.
 */
export function bulkUploadErrorsKey(aggregatorId: string, uploadId: string): string {
  const agg = assertKeySegment(aggregatorId, 'aggregatorId');
  const upload = assertKeySegment(uploadId, 'uploadId');
  return `${BULK_UPLOAD_ERRORS_PREFIX}${agg}/${upload}.csv`;
}

/**
 * Errors-CSV key as written before the tenant prefix was introduced.
 *
 * Only for recognising already-stored keys — never for new writes.
 *
 * @param uploadId - `bulk_uploads.id`.
 */
export function legacyBulkUploadErrorsKey(uploadId: string): string {
  const upload = assertKeySegment(uploadId, 'uploadId');
  return `${LEGACY_BULK_UPLOAD_PREFIX}${upload}/errors.csv`;
}

/**
 * Key of a registration link's QR PNG.
 *
 * @param aggregatorId - Owning aggregator; the tenant prefix segment.
 * @param linkId - `registration_links.id`.
 */
export function qrObjectKey(aggregatorId: string, linkId: string): string {
  const agg = assertKeySegment(aggregatorId, 'aggregatorId');
  const link = assertKeySegment(linkId, 'linkId');
  return `${QR_PREFIX}${agg}/${link}.png`;
}

/**
 * The complete set of errors-CSV keys the api may presign for an upload.
 *
 * This is a signing ALLOW-LIST, not a lookup: the api compares the stored
 * `errors_csv_s3_key` against it and refuses anything else, so a write path or
 * a tampered row cannot talk it into signing an arbitrary object. Widen it only
 * by adding a layout here — never by trusting the stored column.
 *
 * CALLER CONTRACT: the legacy entry is derived from `uploadId` ALONE — the
 * pre-migration layout had no tenant segment — so this function cannot by
 * itself keep one aggregator off another's objects. The caller MUST already
 * have established that `uploadId` belongs to `aggregatorId` (today: the store
 * fetch is scoped by aggregator id). A future admin, support, or cross-org read
 * path that resolves an upload row without that predicate makes the legacy
 * branch cross-tenant. Retire the legacy entry once the bucket lifecycle window
 * for `bulk-uploads/` has elapsed.
 *
 * @param aggregatorId - Owning aggregator, from the caller's session.
 * @param uploadId - `bulk_uploads.id` the caller has ALREADY been shown to own.
 * @returns Current layout first, then the pre-migration one.
 */
export function allowedBulkUploadErrorsKeys(
  aggregatorId: string,
  uploadId: string,
): readonly string[] {
  return [bulkUploadErrorsKey(aggregatorId, uploadId), legacyBulkUploadErrorsKey(uploadId)];
}
