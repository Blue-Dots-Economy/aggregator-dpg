-- Migration 0034: organisation `child_known_as`; every `known_as` reset to `aggregator`.
-- * `organisations.child_known_as`: the "known as" values an org defines for
--   its direct children, a JSON array of `{ key, name, default? }`. The API
--   validates the entries; the database checks only that it is an array.
-- * `organisations.known_as` holds a key from the parent's `child_known_as`,
--   or `aggregator`. Keys from the instance config are not in any list, so
--   every org is reset to `aggregator`. Only a display label changes.
--   `updated_at` is not bumped.
-- Idempotent; boot-safe while older pods keep serving.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0034_org_child_known_as'));

-- Run as the table owner (same rule as 0025–0033).
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
      RAISE EXCEPTION '0034: run as the owner of "organisations" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS child_known_as jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organisations'::regclass
                    AND conname = 'organisations_child_known_as_chk') THEN
    ALTER TABLE organisations ADD CONSTRAINT organisations_child_known_as_chk
      CHECK (jsonb_typeof(child_known_as) = 'array');
  END IF;
END $$;

UPDATE organisations SET known_as = 'aggregator' WHERE known_as <> 'aggregator';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
