-- Migration 0037: `users.locations`, the coordinator's own address.
-- * One Beckn location per entry, the same shape as `organisations.locations`:
--   `[{"geo": {"type": "Point", "coordinates": [lng, lat]}, "address": {...}}]`.
--   Written at registration; `[0,0]` when no address suggestion was picked.
-- * Existing rows get `[]`. `legacy_org_details` is not touched.
-- Additive and idempotent; boot-safe while older pods keep serving.
-- Rollback: `ALTER TABLE users DROP COLUMN locations;`

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0037_user_locations'));

-- Run as the table owner (same rule as 0025–0036).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.users');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0037: run as the owner of "users" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS locations jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass
                    AND conname = 'users_locations_array_chk') THEN
    ALTER TABLE users ADD CONSTRAINT users_locations_array_chk
      CHECK (jsonb_typeof(locations) = 'array');
  END IF;
END $$;

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
