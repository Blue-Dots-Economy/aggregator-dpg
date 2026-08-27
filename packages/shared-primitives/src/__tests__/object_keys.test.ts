import { describe, expect, it } from 'vitest';
import {
  BULK_UPLOAD_ERRORS_PREFIX,
  BULK_UPLOAD_RAW_PREFIX,
  QR_PREFIX,
  allowedBulkUploadErrorsKeys,
  bulkUploadErrorsKey,
  bulkUploadRawKey,
  legacyBulkUploadErrorsKey,
  qrObjectKey,
} from '../object_keys/index.js';

const AGG = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';

describe('object key layout', () => {
  it('builds a tenant-prefixed raw upload key under the raw prefix', () => {
    expect(bulkUploadRawKey(AGG, UPLOAD)).toBe(`uploads/raw/${AGG}/${UPLOAD}.csv`);
    expect(bulkUploadRawKey(AGG, UPLOAD).startsWith(BULK_UPLOAD_RAW_PREFIX)).toBe(true);
  });

  it('builds a tenant-prefixed errors key under the errors prefix', () => {
    expect(bulkUploadErrorsKey(AGG, UPLOAD)).toBe(`uploads/errors/${AGG}/${UPLOAD}.csv`);
    expect(bulkUploadErrorsKey(AGG, UPLOAD).startsWith(BULK_UPLOAD_ERRORS_PREFIX)).toBe(true);
  });

  it('keeps the raw and errors prefixes disjoint so lifecycle rules can differ', () => {
    expect(BULK_UPLOAD_RAW_PREFIX.startsWith(BULK_UPLOAD_ERRORS_PREFIX)).toBe(false);
    expect(BULK_UPLOAD_ERRORS_PREFIX.startsWith(BULK_UPLOAD_RAW_PREFIX)).toBe(false);
  });

  it('builds a tenant-prefixed QR key under the durable prefix', () => {
    expect(qrObjectKey(AGG, LINK)).toBe(`qr/${AGG}/${LINK}.png`);
    expect(qrObjectKey(AGG, LINK).startsWith(QR_PREFIX)).toBe(true);
  });

  it('reproduces the pre-migration errors key, which had no tenant segment', () => {
    expect(legacyBulkUploadErrorsKey(UPLOAD)).toBe(`bulk-uploads/${UPLOAD}/errors.csv`);
  });

  it('allows exactly the current and legacy errors layouts, in that order', () => {
    expect(allowedBulkUploadErrorsKeys(AGG, UPLOAD)).toEqual([
      `uploads/errors/${AGG}/${UPLOAD}.csv`,
      `bulk-uploads/${UPLOAD}/errors.csv`,
    ]);
  });

  it('accepts the id shapes real callers pass', () => {
    // UUIDs from the database, and the short slug-ish ids the test fakes use.
    expect(() => bulkUploadRawKey(AGG, UPLOAD)).not.toThrow();
    expect(() => qrObjectKey('agg-1', 'link-1')).not.toThrow();
    expect(() => qrObjectKey('AGG_1', 'Link_2')).not.toThrow();
  });

  // The validator is a positive allow-list, not a denylist of "dangerous"
  // characters: interpolating unvalidated input into an object key is a
  // path-traversal primitive, and the API's signing allow-list compares against
  // these builders. A denylist has to enumerate separators, traversals, control
  // characters, percent-encoded separators, unicode line separators and length
  // limits — and admits whatever the next reviewer forgets.
  describe.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a path separator', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a parent traversal', '..'],
    ['an embedded traversal', 'a/../b'],
    ['a NUL byte', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a percent-encoded separator', 'a%2Fb'],
    ['a percent-encoded traversal', '%2E%2E'],
    ['a bare dot', '.'],
    ['a dot inside', 'a.b'],
    ['leading whitespace', ' abc'],
    ['trailing whitespace', 'abc '],
    ['a C1 control character', 'a\u0085b'],
    ['a unicode line separator', 'a\u2028b'],
    ['a non-ASCII letter', 'aéb'],
    // S3 caps a key at 1024 bytes. An over-long id must fail here, not as a
    // KeyTooLongError from S3 at request time.
    ['more than 64 characters', 'a'.repeat(65)],
  ])('rejects a segment containing %s', (_label, bad) => {
    it('in every builder', () => {
      expect(() => bulkUploadRawKey(bad, UPLOAD)).toThrow(/segment/i);
      expect(() => bulkUploadRawKey(AGG, bad)).toThrow(/segment/i);
      expect(() => bulkUploadErrorsKey(bad, UPLOAD)).toThrow(/segment/i);
      expect(() => qrObjectKey(bad, LINK)).toThrow(/segment/i);
      expect(() => legacyBulkUploadErrorsKey(bad)).toThrow(/segment/i);
      expect(() => allowedBulkUploadErrorsKeys(bad, UPLOAD)).toThrow(/segment/i);
    });
  });

  it('names the offending parameter so a caller can find the bad input', () => {
    expect(() => bulkUploadRawKey('', UPLOAD)).toThrow(/aggregatorId/);
    expect(() => bulkUploadRawKey(AGG, '')).toThrow(/uploadId/);
    expect(() => qrObjectKey(AGG, '')).toThrow(/linkId/);
  });
});
