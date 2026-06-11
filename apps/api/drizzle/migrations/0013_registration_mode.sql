-- Migration 0013 — per-link registration_mode.
--
-- Adds `registration_links.registration_mode`: an open snake_case text key
-- that names the admin-facing capture channel (e.g. `voice`, `form`). The
-- mode → form-shape mapping lives in the live network config
-- (aggregator.config.yaml under `registration_modes`) and is validated at
-- the application layer, so this column is intentionally NOT a closed enum.
--
-- Default 'form' (full RJSF + silent partial-accept) preserves the legacy
-- behaviour for links created before a mode is chosen. The CHECK constraint
-- only enforces the snake_case shape, not membership — membership is a
-- per-network config concern resolved at request time.
--
-- No data backfill required: prior `submission_mode` variants existed only in
-- local development databases.

ALTER TABLE "registration_links"
  ADD COLUMN IF NOT EXISTS "registration_mode" text NOT NULL DEFAULT 'form';

DO $$ BEGIN
  ALTER TABLE "registration_links"
    ADD CONSTRAINT "registration_links_registration_mode_check"
    CHECK ("registration_mode" ~ '^[a-z][a-z0-9_]*$');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
