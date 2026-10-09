-- RBAC R3 backfill: give every active coordinator a PII Access grant, so
-- turning RBAC_MODE=enforce does not take away the decrypted-profile export
-- coordinators have today (docs/rbac/rbac-implementation-plan.md, open item 1).
--
-- Run ONCE per instance, after migration 0030 and BEFORE RBAC_MODE=enforce:
--   psql "$DATABASE_URL" -v days=90 -f scripts/sql/rbac-backfill-pii-access.sql
-- `days` must not exceed rbac.yaml grants.pii_access.max_days (default 90).
-- Idempotent: a coordinator that already holds a live pii_access grant is
-- skipped. Each grant is audited (`grant.backfill`, granted_by NULL = system).
-- Counts only in the output — never PII.
\set ON_ERROR_STOP on
\if :{?days}
\else
  \set days 90
\endif

BEGIN;

WITH targets AS (
  SELECT u.id, u.org_id
    FROM users u
   WHERE u.user_type = 'coordinator'
     AND u.status = 'active'
     AND NOT EXISTS (
           SELECT 1 FROM user_permission_grant g
            WHERE g.user_id = u.id
              AND g.grant_key = 'pii_access'
              AND g.revoked_at IS NULL
              AND g.expires_at > now())
),
granted AS (
  INSERT INTO user_permission_grant (user_id, grant_key, capability, granted_by, expires_at)
  SELECT id, 'pii_access', 'profiles.view_pii', NULL, now() + make_interval(days => :days)
    FROM targets
  RETURNING user_id
),
audited AS (
  INSERT INTO iam_audit (event, actor_user_id, target_user_id, target_org_id, details)
  SELECT 'grant.backfill', NULL, t.id, t.org_id,
         jsonb_build_object('grant_key', 'pii_access', 'capability', 'profiles.view_pii', 'days', :days)
    FROM targets t
    JOIN granted g ON g.user_id = t.id
  RETURNING 1
)
SELECT (SELECT count(*) FROM granted) AS grants_created,
       (SELECT count(*) FROM audited) AS audit_rows;

COMMIT;
