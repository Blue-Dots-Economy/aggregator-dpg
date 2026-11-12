-- Migration 0036: one pending invite per (org, role, email), so an org can hold a coordinator and an org-owner invite for one address.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0036_invite_role'));

DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.registration_invites');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0036: run as the owner of "registration_invites" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS registration_invites_pending_unique;
CREATE UNIQUE INDEX registration_invites_pending_unique
  ON registration_invites (org_id, role, email) WHERE status = 'pending';

RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
