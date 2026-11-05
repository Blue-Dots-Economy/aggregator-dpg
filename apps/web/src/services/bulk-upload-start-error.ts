/**
 * The error for a bulk upload whose start was accepted but could not be
 * confirmed (web app).
 */

/**
 * Thrown when `/start` answered OK with an unreadable body and the upload's
 * status could not be read again either.
 *
 * The upload was started, so the caller must not offer a plain retry: that
 * would upload the same file twice.
 */
export class BulkUploadStartUnreadError extends Error {
  override readonly name = 'BulkUploadStartUnreadError';

  /**
   * @param uploadId - The upload that was started.
   * @param options - The error that stopped the re-read, as `cause`.
   */
  constructor(
    readonly uploadId: string,
    options?: ErrorOptions,
  ) {
    super(`bulk upload ${uploadId} started, but its status could not be read`, options);
  }
}
