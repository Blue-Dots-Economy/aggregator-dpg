-- Pre-flight for migration 0027 (`aggregators` → `users`), read-only.
-- Run against the database BEFORE the train (schema 0022 or 0026). Counts and
-- ids only — never PII. Run by scripts/user-org-migrate.sh preflight.
--
-- Blockers (must be 0): B1–B3. Informational: I1–I3.
\set ON_ERROR_STOP on

-- B1  orgs without an owner contact (0026 makes this impossible; a guard)
SELECT 'B1 orgs_without_contact' AS check_id, count(*) AS n
  FROM aggregator_orgs WHERE contact_id IS NULL;

-- B2  F15: one owner contact with two different Keycloak subjects
SELECT 'B2 owner_contacts_with_several_subjects' AS check_id, count(*) AS n FROM (
  SELECT contact_id FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
   GROUP BY contact_id HAVING count(DISTINCT owner_kc_sub) > 1) d;

-- B3  F15b: one Keycloak subject on the orgs of two different contacts
SELECT 'B3 subjects_on_several_contacts' AS check_id, count(*) AS n FROM (
  SELECT owner_kc_sub FROM aggregator_orgs WHERE owner_kc_sub IS NOT NULL
   GROUP BY owner_kc_sub HAVING count(DISTINCT contact_id) > 1) d;

-- B4  F16: database objects outside the migrations that name the renamed
--     tables / columns (functions, views). The known ones are recreated by
--     0027 and excluded here.
SELECT 'B4 unknown_dependent_objects' AS check_id, count(*) AS n FROM (
  SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.prosrc ~ '\m(aggregators|org_slug|aggregator_id)\M'
     AND p.proname NOT IN ('aggregators_lock_slug', 'contact_gc', 'aggregators_contact_ad',
                           'aggregator_orgs_contact_ad', 'contact_link', 'contact_move',
                           'aggregators_contact_bi', 'aggregators_contact_bu', 'aggregators_contact_au')
  UNION ALL
  SELECT v.viewname FROM pg_views v
   WHERE v.schemaname = 'public' AND v.definition ~ '\m(aggregators|org_slug|aggregator_id)\M') d;

-- I1  F11: owners of several orgs (they get ONE admin account)
SELECT 'I1 owners_of_several_orgs' AS check_id, count(*) AS n FROM (
  SELECT contact_id FROM aggregator_orgs GROUP BY contact_id HAVING count(*) > 1) d;

-- I2  F3: persons who are both an org owner and a coordinator
SELECT 'I2 owner_and_coordinator' AS check_id, count(*) AS n
  FROM aggregator_orgs o WHERE EXISTS (SELECT 1 FROM aggregators a WHERE a.contact_id = o.contact_id);

-- I3  coordinators (their Keycloak identity is filled later by `enrich`)
SELECT 'I3 coordinators_without_identity_after_0027' AS check_id, count(*) AS n FROM aggregators;
