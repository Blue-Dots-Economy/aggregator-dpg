-- Migration 0032 — organisation "known as" label (design:
-- docs/plans/org-known-as.md §3.2).
-- * `organisations.known_as`: the key of the org's "known as" label, from the
--   instance's `organisation.known_as` config list. Validated on write by the
--   API, not by the database, because the list differs per instance.
-- Existing rows take the default `aggregator` without a table rewrite.
-- Additive and idempotent; applied at boot after the user & org release train.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0032_org_known_as'));

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

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS known_as text NOT NULL DEFAULT 'aggregator';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
