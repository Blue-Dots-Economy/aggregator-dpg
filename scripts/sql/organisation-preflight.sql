-- Pre-flight for migration 0028 (`organisations`), read-only.
-- Run against the database BEFORE the train (it reads the 0027 shape; on an
-- instance at 0022 run it on the dry-run copy after 0027). Counts only —
-- never PII. Run by scripts/user-org-migrate.sh preflight.
--
-- Blockers (must be 0): P1. Informational: P2–P5 (who will notice what).
\set ON_ERROR_STOP on

-- Each coordinator's own org details, read once (a session-local TEMP VIEW,
-- the one object this script creates). `own_loc` is true when its locations
-- hold a street, a locality or real coordinates.
CREATE TEMP VIEW pre_coord AS
SELECT u.id, u.parent_org_id, u.status,
       nullif(btrim(u.url), '') AS own_url,
       EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(u.locations, '[]'::jsonb)) e
                WHERE nullif(btrim(e #>> '{address,streetAddress}'), '') IS NOT NULL
                   OR nullif(btrim(e #>> '{address,addressLocality}'), '') IS NOT NULL
                   OR e #> '{geo,coordinates}' NOT IN ('[0,0]'::jsonb, '[0.0,0.0]'::jsonb)) AS own_loc,
       nullif(btrim(u.contact_extra ->> 'company'), '') AS own_company,
       nullif(btrim(u.contact_extra ->> 'gstNumber'), '') AS own_gst
  FROM users u
 WHERE u.user_type = 'coordinator';

-- P1  orgs whose owner is not an admin account (0027 makes it impossible; a guard)
SELECT 'P1 orgs_with_non_admin_owner' AS check_id, count(*) AS n
  FROM aggregator_orgs o LEFT JOIN users u ON u.id = o.owner_user_id
 WHERE u.id IS NULL OR u.user_type <> 'admin';

-- P2  orgs that 0028 renames to free the fixed Default org (expected 0)
SELECT 'P2 orgs_named_or_slugged_default' AS check_id, count(*) AS n
  FROM aggregator_orgs
 WHERE (lower(display_name) = 'default' AND status IN ('pending', 'active'))
    OR slug = 'default';

-- P3  F13: active coordinators of a real org whose own url / company / GST is
--     set and not shared by every active member (they will see the org's value,
--     or none, instead of their own). Locations are counted the same way.
WITH per_org AS (
  SELECT parent_org_id,
         count(DISTINCT own_url)     FILTER (WHERE own_url IS NOT NULL)     AS urls,
         count(DISTINCT own_company) FILTER (WHERE own_company IS NOT NULL) AS companies,
         count(DISTINCT own_gst)     FILTER (WHERE own_gst IS NOT NULL)     AS gsts
    FROM pre_coord
   WHERE parent_org_id IS NOT NULL AND status = 'active'
   GROUP BY parent_org_id)
SELECT 'P3 orgs_with_disagreeing_coordinators' AS check_id, count(*) AS n
  FROM per_org
 WHERE urls > 1 OR companies > 1 OR gsts > 1;

-- P4  coordinators that move into the Default org (formerly flat)
SELECT 'P4 coordinators_into_default' AS check_id, count(*) AS n
  FROM pre_coord WHERE parent_org_id IS NULL;

-- P5  orgs whose own address cannot become a Beckn location (no street,
--     locality or picked point): they rely on adoption or stay empty
SELECT 'P5 orgs_without_usable_address' AS check_id, count(*) AS n
  FROM aggregator_orgs o
 WHERE nullif(btrim(o.profile #>> '{address,streetAddress}'), '') IS NULL
   AND nullif(btrim(o.profile #>> '{address,addressLocality}'), '') IS NULL
   AND jsonb_typeof(o.profile -> 'coordinates') IS DISTINCT FROM 'array';
