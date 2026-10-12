-- Pre-flight for migration 0029 (`cleanup`), read-only.
-- Run against the database BEFORE 0029 (it reads the 0028 shape; on an
-- instance at 0022 run it on the dry-run copy after 0028). Counts only —
-- never PII. Run by scripts/user-org-migrate.sh preflight.
--
-- Blockers (must be 0): Q2, Q9, Q10, Q11, Q12 (0029 refuses them too).
-- Informational: the rest. Creates one session-local helper (pg_temp), so run
-- it on the primary or the dry-run copy, not a read-only replica.
\set ON_ERROR_STOP on

-- A timestamp, or NULL when the text does not parse (session-local helper).
CREATE OR REPLACE FUNCTION pg_temp.ts(p text)
  RETURNS timestamptz LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  RETURN p::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $fn$;

-- Q1  coordinators whose consent exists only in the column (0029 writes a
--     `registration-backfill` ledger row for each)
SELECT 'Q1 consent_backfilled' AS check_id, count(*) AS n
  FROM users u
 WHERE u.user_type = 'coordinator' AND u.consent IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM aggregator_consent_record c
                    WHERE c.subject_type = 'aggregator' AND c.subject_id = u.id
                      AND c.source IN ('registration', 'registration-backfill'));

-- Q1b the network the backfill will record: 0 = taken from the ledger;
--     1 = the ledger is empty, so the tool must pass aggregator_dpg.network
SELECT 'Q1b backfill_needs_network_guc' AS check_id,
       (NOT EXISTS (SELECT 1 FROM aggregator_consent_record))::int AS n;

-- Q2  BLOCKER: a stored consent whose value is not true (the ledger cannot
--     represent it; resolve by hand)
SELECT 'Q2 consent_value_not_true' AS check_id, count(*) AS n
  FROM users
 WHERE user_type = 'coordinator' AND consent IS NOT NULL
   AND consent->>'value' IS DISTINCT FROM 'true';

-- Q3  given_at vs the ledger's accepted_at, more than 1 s apart (accepted,
--     D4-3: the profile shows the ledger's time from now on); max gap in s
SELECT 'Q3 consent_given_at_gap_over_1s' AS check_id, count(*) AS n,
       coalesce(max(gap), 0)::int AS max_gap_s
  FROM (SELECT abs(extract(epoch FROM pg_temp.ts(u.consent->>'given_at') - c.accepted_at)) AS gap
          FROM users u
          JOIN LATERAL (SELECT accepted_at FROM aggregator_consent_record c
                         WHERE c.subject_type = 'aggregator' AND c.subject_id = u.id
                           AND c.source = 'registration'
                         ORDER BY accepted_at DESC LIMIT 1) c ON true
         WHERE u.user_type = 'coordinator' AND u.consent IS NOT NULL) g
 WHERE gap > 1;

-- Q4  type 'both', blank or NULL (→ serves = '{}', every domain); compare
--     the distinct values with the network's domain ids by hand
SELECT 'Q4 type_every_domain' AS check_id, count(*) AS n
  FROM users
 WHERE user_type = 'coordinator' AND (nullif(btrim(type), '') IS NULL OR btrim(type) = 'both');
SELECT 'Q4c distinct_types' AS check_id, count(DISTINCT btrim(type)) AS n,
       string_agg(DISTINCT btrim(type), ',') AS domain_ids
  FROM users WHERE user_type = 'coordinator' AND nullif(btrim(type), '') IS NOT NULL;

-- Q4b alternate phones that are blank or padded (copied verbatim)
SELECT 'Q4b alternate_phone_blank_or_padded' AS check_id, count(*) AS n
  FROM users
 WHERE jsonb_typeof(contact_extra->'alternatePhone') = 'string'
   AND contact_extra->>'alternatePhone' IS DISTINCT FROM nullif(btrim(contact_extra->>'alternatePhone'), '');

-- Q5  invited coordinators with no consumed invite to link (address kept in
--     profile.legacy_invite_email) / sharing candidates with others (0029
--     hands them out in registration order, nearest first; a coordinator
--     left without one keeps its address the same way)
SELECT 'Q5 invite_unmatched' AS check_id, count(*) AS n
  FROM users u
 WHERE u.invite_email IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM registration_invites i
                    WHERE lower(btrim(i.email)) = lower(btrim(u.invite_email))
                      AND i.org_id = u.org_id AND i.status = 'consumed');
SELECT 'Q5b invite_ambiguous' AS check_id, count(*) AS n
  FROM users u
 WHERE u.invite_email IS NOT NULL
   AND (SELECT count(*) FROM registration_invites i
         WHERE lower(btrim(i.email)) = lower(btrim(u.invite_email))
           AND i.org_id = u.org_id AND i.status = 'consumed') > 1;

-- Q7  actor_type other than 'aggregator' (the API returns 'aggregator' after)
SELECT 'Q7 actor_type_not_aggregator' AS check_id, count(*) AS n
  FROM users WHERE user_type = 'coordinator' AND actor_type <> 'aggregator';

-- Q8  ledger rows whose subject no longer exists (they stay, unlinked)
SELECT 'Q8 ledger_subject_gone' AS check_id, count(*) AS n
  FROM aggregator_consent_record c
 WHERE (c.subject_type = 'aggregator' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.subject_id))
    OR (c.subject_type = 'org' AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = c.subject_id));

-- Q9  BLOCKER: consent timestamps that do not parse (would abort the train)
SELECT 'Q9 consent_bad_timestamp' AS check_id, count(*) AS n
  FROM users
 WHERE user_type = 'coordinator' AND consent IS NOT NULL
   AND (pg_temp.ts(consent->>'given_at') IS NULL
        OR (consent->>'valid_till' IS NOT NULL AND pg_temp.ts(consent->>'valid_till') IS NULL));

-- Q10 BLOCKER: functions or views naming a column 0029 drops or renames
--     (F16); expected 0 — 0029 recreates none
SELECT 'Q10 objects_naming_dropped_columns' AS check_id, count(*) AS n
  FROM (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosrc ~ '\m(contact_extra|actor_type|invite_email|aggregator_consent_record|actor_org_id|aggregator_status|aggregator_actor_type)\M'
        UNION ALL
        SELECT 0 FROM pg_views v
         WHERE v.schemaname = 'public'
           AND v.definition ~ '\m(contact_extra|actor_type|invite_email|aggregator_consent_record|actor_org_id|aggregator_status|aggregator_actor_type)\M') d;

-- Q11 BLOCKER: contact_extra holding anything but a string alternatePhone
--     (it would be lost with the column; 0029 refuses it)
SELECT 'Q11 contact_extra_unmovable' AS check_id, count(*) AS n
  FROM users
 WHERE contact_extra IS NOT NULL
   AND (contact_extra - 'alternatePhone' <> '{}'::jsonb
        OR coalesce(jsonb_typeof(contact_extra->'alternatePhone'), 'null') NOT IN ('string', 'null'));

-- Q12 BLOCKER: ledger rows with a subject type 0029 cannot map
SELECT 'Q12 ledger_unknown_subject_type' AS check_id, count(*) AS n
  FROM aggregator_consent_record WHERE subject_type NOT IN ('aggregator', 'org');
