-- Migration 0009 — drop counter columns from `bulk_uploads`.
--
-- Counters (`total_rows`, `passed`, `failed`, `skipped`) move out of
-- `bulk_uploads` so the table holds only operational lifecycle state.
-- Live counts now live in Redis during the run; terminal counts live
-- in the `onboarding` row that `bulk-finalise` writes per upload.
--
-- Backfill before dropping: any historical `completed` row that lacks a
-- corresponding `onboarding` row gets one synthesised from its counter
-- columns. Without this step the dashboard would lose history when the
-- columns disappear.

-- 1. Backfill missing onboarding rows from completed bulk_uploads.
INSERT INTO onboarding (
  aggregator_id, org_slug, source, batch_id, link_id,
  period_start, period_end, total, passed, failed, skipped, created_at
)
SELECT
  bu.aggregator_id,
  a.org_slug,
  'bulk'::onboarding_source,
  bu.id,
  NULL,
  bu.created_at,
  COALESCE(bu.completed_at, bu.updated_at),
  COALESCE(bu.total_rows, COALESCE(bu.passed, 0) + COALESCE(bu.failed, 0) + COALESCE(bu.skipped, 0)),
  COALESCE(bu.passed, 0),
  COALESCE(bu.failed, 0),
  COALESCE(bu.skipped, 0),
  NOW()
FROM bulk_uploads bu
JOIN aggregators a ON a.id = bu.aggregator_id
WHERE bu.status = 'completed'
  AND NOT EXISTS (
    SELECT 1 FROM onboarding o
    WHERE o.source = 'bulk' AND o.batch_id = bu.id
  );

-- 2. Drop the columns.
ALTER TABLE bulk_uploads
  DROP COLUMN total_rows,
  DROP COLUMN passed,
  DROP COLUMN failed,
  DROP COLUMN skipped;
