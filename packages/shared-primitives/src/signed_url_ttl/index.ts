/**
 * Lifetime policy for pre-signed object-storage URLs.
 *
 * Lives in a shared package because it is a deployment contract, not an app
 * detail: the same env var name and the same ceiling have to mean the same
 * thing in every process that mints a URL, and the Helm chart renders it from
 * one value.
 *
 * @module @aggregator-dpg/shared-primitives
 */

import { z } from 'zod';

/** Canonical TTL when nothing overrides it: ten minutes. */
export const SIGNED_URL_TTL_DEFAULT_SECONDS = 600;

/**
 * Hard ceiling on any pre-signed URL lifetime: one hour.
 *
 * A pre-signed URL is a bearer credential for one object and **cannot be
 * revoked** before it expires. A multi-day TTL is therefore indistinguishable
 * from publishing a durable public URL, which is precisely the posture the
 * private-bucket migration removes. Exceeding this fails config parsing at
 * boot: a deploy that refuses to start is recoverable, a bucket quietly
 * readable for a week is not.
 */
export const SIGNED_URL_TTL_MAX_SECONDS = 3600;

/**
 * Bounds shared by the canonical TTL and every per-class override.
 *
 * `z.coerce` because environment variables always arrive as strings.
 */
export const SignedUrlTtlSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(SIGNED_URL_TTL_MAX_SECONDS);

/** Raw TTL settings as they appear in the environment. */
export interface SignedUrlTtlEnv {
  /** Canonical TTL applied to every class that has no override. */
  SIGNED_URL_TTL_SECONDS: number;
  /** Optional override for the bulk-upload pre-signed PUT. */
  BULK_UPLOAD_URL_TTL_SECONDS?: number | undefined;
  /** Optional override for the errors-CSV pre-signed GET. */
  ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS?: number | undefined;
  /** Optional override for the QR PNG pre-signed GET. */
  QR_DOWNLOAD_URL_TTL_SECONDS?: number | undefined;
}

/** Effective TTL, in seconds, per class of pre-signed URL. */
export interface SignedUrlTtls {
  /** Browser PUT of a raw bulk-upload CSV. */
  readonly bulkUpload: number;
  /** Browser GET of a generated errors CSV. */
  readonly errorsCsvDownload: number;
  /** Browser GET of a registration-link QR PNG. */
  readonly qrDownload: number;
}

/**
 * Collapses the canonical TTL and its optional per-class overrides into the
 * effective value for each class.
 *
 * Resolution lives here, not at the call sites, so no caller has to remember
 * which fallback applies — a use site that reaches for the raw env value is a
 * bug waiting to diverge.
 *
 * @param env - Parsed TTL settings.
 * @returns Effective seconds for each class of pre-signed URL.
 */
export function resolveSignedUrlTtls(env: SignedUrlTtlEnv): SignedUrlTtls {
  const fallback = env.SIGNED_URL_TTL_SECONDS;
  return {
    bulkUpload: env.BULK_UPLOAD_URL_TTL_SECONDS ?? fallback,
    errorsCsvDownload: env.ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS ?? fallback,
    qrDownload: env.QR_DOWNLOAD_URL_TTL_SECONDS ?? fallback,
  };
}
