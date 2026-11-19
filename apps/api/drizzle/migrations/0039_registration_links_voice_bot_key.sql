-- Migration 0039: `registration_links.voice_bot_key`, the voice bot chosen for a link at create.
-- * A `voice_bots` config key. Nullable: existing links, and links without a voice option, stay NULL.
-- * Immutable after create (no update path writes it).
-- Additive and idempotent; boot-safe while older pods keep serving.
-- Rollback: `ALTER TABLE registration_links DROP COLUMN voice_bot_key;`

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0039_registration_links_voice_bot_key'));

-- Run as the table owner (same rule as 0025–0038).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.registration_links');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0039: run as the owner of "registration_links" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE registration_links ADD COLUMN IF NOT EXISTS voice_bot_key text;

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
