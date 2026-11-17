-- Migration 0039: built-in role `coordinator` is named "Onboard Seekers & Providers".
-- * The console shows the role by what it lets a team member do, the same
--   wording the invite screens use for the capability.
-- * Only the display name changes. The key stays `coordinator`, so tokens,
--   assignments and the edge policy are untouched.
-- * Changes a built-in role through a new migration, as 0031 requires; the
--   source of truth is BUILTIN_ROLES in packages/rbac.
-- Idempotent; boot-safe while older pods keep serving (they read the same
-- catalogue and pick up the name on their next refresh).

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0039_coordinator_role_name'));

-- Run as the table owner (same rule as 0025–0038).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.role');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0039: run as the owner of "role" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

UPDATE role SET name = 'Onboard Seekers & Providers'
 WHERE key = 'coordinator' AND name IS DISTINCT FROM 'Onboard Seekers & Providers';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
