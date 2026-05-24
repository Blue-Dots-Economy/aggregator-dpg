-- Migration 0011 — drop the partial UNIQUE on (aggregator_id, s3_etag).
--
-- Product change: aggregators are allowed to re-upload the same CSV
-- bytes against a successful run. The partial UNIQUE introduced in 0007
-- short-circuited those re-uploads with a "this CSV was already
-- uploaded" response, which surprises operators who deliberately want
-- to replay a batch.
--
-- The history of past runs (including duplicates) is preserved — we
-- only relax the constraint so two runs with the same etag can coexist.

DROP INDEX IF EXISTS "bulk_uploads_aggregator_etag_unique";
