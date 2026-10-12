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

-- P2  orgs that 0028 renames to free the fixed Default org and the root's
--     placeholder (original values are kept in profile.renamed_from; expected 0)
SELECT 'P2 orgs_renamed_for_default_or_root' AS check_id, count(*) AS n
  FROM aggregator_orgs
 WHERE (lower(display_name) IN ('default', 'network') AND status IN ('pending', 'active'))
    OR slug IN ('default', 'network');

-- P3  F13: active coordinators of a real org whose own url / locations /
--     company / GST (empty included) is not shared by every active member —
--     after the window they see the org's value (or none) instead of their own
WITH own AS (
  SELECT u.id, u.parent_org_id,
         coalesce(nullif(btrim(u.url), ''), '')                         AS url,
         coalesce(u.locations, '[]'::jsonb)                              AS locations,
         coalesce(nullif(btrim(u.contact_extra ->> 'company'), ''), '')   AS company,
         coalesce(nullif(btrim(u.contact_extra ->> 'gstNumber'), ''), '') AS gst
    FROM users u
   WHERE u.user_type = 'coordinator' AND u.status = 'active' AND u.parent_org_id IS NOT NULL),
disagreeing AS (
  SELECT parent_org_id
    FROM own
   GROUP BY parent_org_id
  HAVING count(DISTINCT url) > 1 OR count(DISTINCT locations) > 1
      OR count(DISTINCT company) > 1 OR count(DISTINCT gst) > 1)
SELECT 'P3 coordinators_seeing_org_values' AS check_id, count(*) AS n
  FROM own WHERE parent_org_id IN (SELECT parent_org_id FROM disagreeing);

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
