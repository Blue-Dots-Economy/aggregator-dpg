-- Migration 0032 — organisation description and domains.
-- * `description`: free text the org owner writes about the organisation.
-- * `domains`: the network domain ids the organisation says it serves
--   (`'{}'` = not stated). Informational only: nothing reads it to grant
--   access, and it is not sent to Signals.
-- Both are edited by the org owner in the console.
-- Additive and idempotent; applied at boot after the user & org release train.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0032_org_description_domains'));

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

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS domains text[] NOT NULL DEFAULT '{}';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
