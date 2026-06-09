-- Migration 0015 — rename per-link submission_mode → registration_mode.
--
-- Drops the closed-enum `submission_mode` column (introduced in 0014)
-- and adds a fresh open-text `registration_mode` column whose value is
-- validated against the live network config's `registration_modes`
-- block at the application layer. Default 'form' (full RJSF + silent
-- partial-accept). No data backfill required — submission_mode was
-- only in local development DBs.

ALTER TABLE "registration_links" DROP COLUMN IF EXISTS "submission_mode";

ALTER TABLE "registration_links"
  ADD COLUMN IF NOT EXISTS "registration_mode" text NOT NULL DEFAULT 'form';

DO $$ BEGIN
  ALTER TABLE "registration_links"
    ADD CONSTRAINT "registration_links_registration_mode_check"
    CHECK ("registration_mode" ~ '^[a-z][a-z0-9_]*$');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
