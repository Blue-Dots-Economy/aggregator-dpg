-- Migration 0034: table `org_known_as`; every `known_as` reset to `aggregator`.
-- * `org_known_as`: the "known as" values an org defines for its direct
--   children, one row per value. `key` is made by the API from the name and
--   never changes; `position` is the order of the list; at most one row per
--   org is the default (the value new children get). Names are unique per org,
--   ignoring case. The API caps a list at 20 rows. The rows go with their org.
-- * `organisations.known_as` holds a key of the parent's rows, or
--   `aggregator`. Keys from the instance config are in no org's rows, so every
--   org is reset to `aggregator`. Only a display label changes.
--   `updated_at` is not bumped.
-- Idempotent; boot-safe while older pods keep serving.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0034_org_known_as'));

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

CREATE TABLE IF NOT EXISTS org_known_as (
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  key         text NOT NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  position    smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_known_as_pkey PRIMARY KEY (org_id, key),
  -- Same rule as the API's KnownAsKeySchema.
  CONSTRAINT org_known_as_key_chk CHECK (key ~ '^[a-z][a-z0-9_]*$' AND char_length(key) <= 64),
  -- Same rule as the API's name schema: trimmed, 1 to 60 characters (KNOWN_AS_NAME_MAX).
  CONSTRAINT org_known_as_name_chk CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT org_known_as_position_chk CHECK (position >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_known_as_default_unique
  ON org_known_as (org_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS org_known_as_name_unique
  ON org_known_as (org_id, lower(name));

UPDATE organisations SET known_as = 'aggregator' WHERE known_as <> 'aggregator';

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
