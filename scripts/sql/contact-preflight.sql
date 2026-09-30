-- contact-preflight.sql — READ-ONLY pre-flight for migration 0025 (`contact`).
--
-- Run BEFORE `scripts/contact-migrate.sh apply` on an existing instance.
-- Every "blocking" count must be 0; otherwise 0025 refuses to create the table
-- (its first-creation guard re-runs the same checks). Fix the listed rows by
-- hand, coordinating with Keycloak (it holds the same identity), then re-run.
--
-- Output is row ids and counts only — never an email, phone or name — so it
-- is safe to paste into a ticket.

\echo '== contact pre-flight (blocking checks must all be 0) =='

WITH src AS (
  SELECT 'aggregators'::text AS tbl, id, lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p
    FROM aggregators
  UNION ALL
  SELECT 'aggregator_orgs', id, lower(btrim(owner_email)), owner_phone
    FROM aggregator_orgs
)
SELECT check_name, blocking, n FROM (
  SELECT 1 AS ord, 'email_with_many_phones' AS check_name, true AS blocking,
         (SELECT count(*) FROM (SELECT e FROM src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1) x) AS n
  UNION ALL
  SELECT 2, 'phone_with_many_emails', true,
         (SELECT count(*) FROM (SELECT p FROM src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1) x)
  UNION ALL
  SELECT 3, 'non_canonical_phone', true,
         (SELECT count(*) FROM src WHERE p IS NOT NULL AND p !~ '^\+[0-9]{10,15}$')
  UNION ALL
  SELECT 4, 'blank_email', true,
         (SELECT count(*) FROM src WHERE coalesce(e, '') = '')
  UNION ALL
  SELECT 5, 'non_ascii_email (informational)', false,
         (SELECT count(*) FROM src WHERE e ~ '[^\x01-\x7F]')
  UNION ALL
  SELECT 6, 'blank_coordinator_name (informational, becomes NULL)', false,
         (SELECT count(*) FROM aggregators WHERE btrim(coalesce(contact->>'name', '')) = '')
  UNION ALL
  SELECT 7, 'rows_with_contact_extras (informational, move to contact_extra)', false,
         (SELECT count(*) FROM aggregators WHERE (contact - 'name' - 'phone' - 'email') <> '{}'::jsonb)
  UNION ALL
  SELECT 9, 'mixed_case_email (informational, API will return it lowercased)', false,
         (SELECT count(*) FROM aggregators WHERE contact->>'email' <> lower(btrim(contact->>'email')))
  UNION ALL
  SELECT 8, 'inactive_orgs_without_kc_owner (informational, usually safe to delete)', false,
         (SELECT count(*) FROM aggregator_orgs WHERE status = 'inactive' AND owner_kc_sub IS NULL)
) c
ORDER BY ord;

\echo '== rows involved in blocking email/phone conflicts (ids only) =='

WITH src AS (
  SELECT 'aggregators'::text AS tbl, id, status::text AS status,
         lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p
    FROM aggregators
  UNION ALL
  SELECT 'aggregator_orgs', id, status::text, lower(btrim(owner_email)), owner_phone
    FROM aggregator_orgs
),
bad_e AS (SELECT e FROM src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1),
bad_p AS (SELECT p FROM src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1)
SELECT tbl, id, status,
       CASE WHEN e IN (SELECT e FROM bad_e) THEN 'email' ELSE 'phone' END AS conflict_on,
       -- groups rows of the same conflict without printing the value, or any
       -- hash of it (an unsalted hash of an email/phone can be brute-forced)
       dense_rank() OVER (ORDER BY CASE WHEN e IN (SELECT e FROM bad_e) THEN e ELSE p END) AS conflict_group
  FROM src
 WHERE e IN (SELECT e FROM bad_e) OR p IN (SELECT p FROM bad_p)
 ORDER BY 5, tbl, id;

\echo '== inactive orgs without a Keycloak owner (ids only) =='

SELECT id, slug, created_at
  FROM aggregator_orgs
 WHERE status = 'inactive' AND owner_kc_sub IS NULL
 ORDER BY created_at;
