import { describe, expect, it } from 'vitest';
import {
  SIGNED_URL_TTL_DEFAULT_SECONDS,
  SIGNED_URL_TTL_MAX_SECONDS,
  SignedUrlTtlSchema,
  resolveSignedUrlTtls,
} from '../signed_url_ttl/index.js';

describe('signed-url TTL bounds', () => {
  it('defaults to ten minutes', () => {
    expect(SIGNED_URL_TTL_DEFAULT_SECONDS).toBe(600);
  });

  it('caps at one hour', () => {
    expect(SIGNED_URL_TTL_MAX_SECONDS).toBe(3600);
  });

  it('coerces a string, as env vars always arrive', () => {
    expect(SignedUrlTtlSchema.parse('900')).toBe(900);
  });

  it.each([SIGNED_URL_TTL_MAX_SECONDS, 1, 600])('accepts %d seconds', (v) => {
    expect(SignedUrlTtlSchema.parse(v)).toBe(v);
  });

  // A pre-signed URL cannot be revoked. An operator who sets a week has
  // recreated the durable public URL this whole change exists to remove, so the
  // ceiling has to be refused at boot rather than clamped silently.
  it.each([SIGNED_URL_TTL_MAX_SECONDS + 1, 86_400, 604_800])('rejects %d seconds', (v) => {
    expect(() => SignedUrlTtlSchema.parse(v)).toThrow();
  });

  it.each([0, -1, 1.5])('rejects %s as not a positive integer', (v) => {
    expect(() => SignedUrlTtlSchema.parse(v)).toThrow();
  });
});

describe('resolveSignedUrlTtls', () => {
  it('applies the canonical TTL to every class when no override is set', () => {
    expect(
      resolveSignedUrlTtls({
        SIGNED_URL_TTL_SECONDS: 600,
        BULK_UPLOAD_URL_TTL_SECONDS: undefined,
        ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS: undefined,
        QR_DOWNLOAD_URL_TTL_SECONDS: undefined,
      }),
    ).toEqual({ bulkUpload: 600, errorsCsvDownload: 600, qrDownload: 600 });
  });

  it('lets each class be overridden independently', () => {
    expect(
      resolveSignedUrlTtls({
        SIGNED_URL_TTL_SECONDS: 600,
        BULK_UPLOAD_URL_TTL_SECONDS: 1800,
        ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS: undefined,
        QR_DOWNLOAD_URL_TTL_SECONDS: 60,
      }),
    ).toEqual({ bulkUpload: 1800, errorsCsvDownload: 600, qrDownload: 60 });
  });

  // Before this change, errors.csv downloads borrowed the *upload* TTL, so
  // lengthening a slow-link upload window silently lengthened how long a leaked
  // download URL stayed live. They must be independent knobs.
  it('does not let the upload override leak into the errors-CSV download', () => {
    const ttls = resolveSignedUrlTtls({
      SIGNED_URL_TTL_SECONDS: 600,
      BULK_UPLOAD_URL_TTL_SECONDS: 3600,
      ERRORS_CSV_DOWNLOAD_URL_TTL_SECONDS: undefined,
      QR_DOWNLOAD_URL_TTL_SECONDS: undefined,
    });
    expect(ttls.bulkUpload).toBe(3600);
    expect(ttls.errorsCsvDownload).toBe(600);
  });
});
