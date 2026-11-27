-- Migration 0040: one login may link one account per type.
-- * `user_identities.user_type` copies `users.user_type` (backfilled from the
--   linked account, then NOT NULL); a composite FK keeps the two equal.
-- * `UNIQUE (provider, subject)` becomes `UNIQUE (provider, subject, user_type)`,
--   so an admin and a coordinator may share one Keycloak login while two
--   accounts of the same type may not.
-- * `users (id, user_type)` is unique so the composite FK has a target.
-- * A `BEFORE INSERT` trigger fills `user_type` from `users` when an insert
--   leaves it NULL, so pods running an image without the column, and an
--   image rollback, keep recording logins.
-- The primary key `(user_id, provider)` is unchanged: one login per provider
-- per account. Existing rows keep their meaning; the new unique is looser than
-- the old one, so no existing row can violate it.
-- Rollback: an image rollback alone needs no schema change (the trigger fills
-- `user_type`). A schema rollback drops the trigger
-- `user_identities_set_user_type` and its function, the composite FK and the
-- new unique, re-adds `user_identities_provider_subject_unique`, and drops
-- `user_identities.user_type` and `users_id_type_unique` (only valid while no
-- login is shared).

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0040_user_identities_user_type'));

-- Run as the table owner (same rule as 0025–0038).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.user_identities');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0040: run as the owner of "user_identities" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

-- 1. Add the column nullable.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS user_type user_type;

-- 2. Backfill from the linked account (schema-coupled: the NOT NULL below needs it).
UPDATE user_identities ui
   SET user_type = u.user_type
  FROM users u
 WHERE u.id = ui.user_id
   AND ui.user_type IS NULL;

-- 3. Constrain.
ALTER TABLE user_identities ALTER COLUMN user_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.users'::regclass
                    AND conname = 'users_id_type_unique') THEN
    ALTER TABLE users ADD CONSTRAINT users_id_type_unique UNIQUE (id, user_type);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_identities'::regclass
                    AND conname = 'user_identities_provider_subject_type_unique') THEN
    ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_subject_type_unique
      UNIQUE (provider, subject, user_type);
  END IF;
  ALTER TABLE user_identities DROP CONSTRAINT IF EXISTS user_identities_provider_subject_unique;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_identities'::regclass
                    AND conname = 'user_identities_user_type_fk') THEN
    ALTER TABLE user_identities ADD CONSTRAINT user_identities_user_type_fk
      FOREIGN KEY (user_id, user_type) REFERENCES users (id, user_type) ON DELETE CASCADE;
  END IF;
END $$;

-- 4. Fill user_type on inserts that leave it out (older images). A BEFORE
--    trigger runs before the NOT NULL check.
CREATE OR REPLACE FUNCTION user_identities_set_user_type() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.user_type IS NULL THEN
    SELECT u.user_type INTO NEW.user_type FROM users u WHERE u.id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS user_identities_set_user_type ON user_identities;
CREATE TRIGGER user_identities_set_user_type
  BEFORE INSERT ON user_identities
  FOR EACH ROW EXECUTE FUNCTION user_identities_set_user_type();

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
