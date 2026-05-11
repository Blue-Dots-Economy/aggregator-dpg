-- Migration 0007 — partial UNIQUE on (aggregator_id, s3_etag) excluding
-- terminal failures.
--
-- Original 0000 created an unconditional UNIQUE on (aggregator_id, s3_etag).
-- That blocked aggregators from re-uploading the same CSV bytes after a
-- previous run ended in `file_failed` or `failed` — the only escape was to
-- delete history. Product wants failed rows kept for audit AND retries to
-- work. Make the UNIQUE partial: it now applies only to non-failure rows.
--
-- Active runs (pending / uploaded / file_validating / row_processing /
-- finalising / completed) still dedup by content; failed runs no longer
-- occupy the UNIQUE slot.

DROP INDEX IF EXISTS "bulk_uploads_aggregator_etag_unique";--> statement-breakpoint

CREATE UNIQUE INDEX "bulk_uploads_aggregator_etag_unique"
  ON "bulk_uploads" ("aggregator_id", "s3_etag")
  WHERE status NOT IN ('file_failed', 'failed');
