-- Seeds realistic row counts for EXPLAIN baseline captures.
-- Idempotent via ON CONFLICT guards; safe to re-run.
--
-- Usage: psql -U aggregator -d aggregator_dev -f scripts/seed-explain.sql

BEGIN;

-- 3 schema versions, 1 active
INSERT INTO aggregator_profile_schema (id, version, schema_json, active)
SELECT
  gen_random_uuid(), v::text, '{}'::jsonb, (v = 3)
FROM generate_series(1, 3) v
ON CONFLICT DO NOTHING;

-- 10 aggregators on the active schema
INSERT INTO aggregator_profile (aggregator_id, schema_version, values_json)
SELECT
  gen_random_uuid(),
  (SELECT id FROM aggregator_profile_schema WHERE active = true LIMIT 1),
  '{}'::jsonb
FROM generate_series(1, 10)
ON CONFLICT DO NOTHING;

-- 1000 onboarding links spread across all aggregators; ~30% revoked
INSERT INTO onboarding_link (aggregator_id, mode, target_role, label, created_at, revoked_at)
SELECT
  (SELECT aggregator_id FROM aggregator_profile ORDER BY random() LIMIT 1),
  (ARRAY['link', 'qr', 'bulk']::onboarding_mode[])[1 + (n % 3)],
  (ARRAY['seeker', 'provider']::target_role[])[1 + (n % 2)],
  'link-' || n,
  now() - (n || ' minutes')::interval,
  CASE WHEN n % 10 < 3 THEN now() - (n || ' hours')::interval END
FROM generate_series(1, 1000) n;

-- 1000 audit_log entries — varied entity types, varied aggregators
INSERT INTO audit_log (aggregator_id, action, entity, entity_id, occurred_at)
SELECT
  (SELECT aggregator_id FROM aggregator_profile ORDER BY random() LIMIT 1),
  (ARRAY['create', 'update', 'revoke', 'export'])[1 + (n % 4)],
  (ARRAY['onboarding_link', 'export_job', 'aggregator_profile'])[1 + (n % 3)],
  'entity-' || (n % 100)::text,
  now() - (n || ' seconds')::interval
FROM generate_series(1, 1000) n;

-- 100 bulk_upload_batches spread across aggregators
INSERT INTO bulk_upload_batch (aggregator_id, filename, total, succeeded, flagged, created_by)
SELECT
  (SELECT aggregator_id FROM aggregator_profile ORDER BY random() LIMIT 1),
  'batch-' || n || '.csv',
  100, 95, 5, 'user-' || (n % 20)::text
FROM generate_series(1, 100) n;

-- 500 export_jobs — ~20% pending, rest completed
INSERT INTO export_job (aggregator_id, filter_json, status, created_at)
SELECT
  (SELECT aggregator_id FROM aggregator_profile ORDER BY random() LIMIT 1),
  '{}'::jsonb,
  (CASE WHEN n % 5 = 0 THEN 'pending' ELSE 'completed' END)::export_job_status,
  now() - (n || ' minutes')::interval
FROM generate_series(1, 500) n;

-- 200 registration_requests — ~40% pending
INSERT INTO registration_request (org_name, aggregator_type, admin_name, email, phone, consent_at, status, created_at)
SELECT
  'Org ' || n,
  'employer',
  'Admin ' || n,
  'admin' || n || '@example.com',
  '+91' || (9000000000 + n)::text,
  now() - (n || ' hours')::interval,
  (CASE WHEN n % 5 < 2 THEN 'pending' ELSE 'approved' END)::registration_status,
  now() - (n || ' hours')::interval
FROM generate_series(1, 200) n;

ANALYZE aggregator_profile_schema;
ANALYZE aggregator_profile;
ANALYZE onboarding_link;
ANALYZE audit_log;
ANALYZE bulk_upload_batch;
ANALYZE export_job;
ANALYZE registration_request;

COMMIT;
