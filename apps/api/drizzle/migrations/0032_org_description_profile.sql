-- Migration 0032 — organisation description; website and GST number in `profile`.
-- * `description`: free text the org owner writes about the organisation.
-- * Website and GST number are schema-driven organisation fields from now on:
--   their values live in `profile` (`website`, `gst_number`) like every other
--   field of the org-registration schema. Each org's existing `url` /
--   `gst_number` column value is copied into `profile` when `profile` has no
--   such key yet. The columns stay, unused by the app, for one release.
-- Additive and idempotent; applied at boot after the user & org release train.
-- Counts only in messages — never row data.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0032_org_description_profile'));

-- Run as the table owner (same rule as 0025–0031).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.organisations');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0032: run as the owner of "organisations" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS description text;

-- `updated_at` is not bumped: this is a copy, not an edit.
UPDATE organisations
   SET profile = profile || jsonb_build_object('website', url)
 WHERE url IS NOT NULL AND btrim(url) <> '' AND NOT (profile ? 'website');

UPDATE organisations
   SET profile = profile || jsonb_build_object('gst_number', gst_number)
 WHERE gst_number IS NOT NULL AND btrim(gst_number) <> '' AND NOT (profile ? 'gst_number');

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
