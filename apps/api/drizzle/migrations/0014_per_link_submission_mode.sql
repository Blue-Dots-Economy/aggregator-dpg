-- Migration 0014 — per-link submission_mode.
--
-- Adds `registration_links.submission_mode` to lock each registration
-- link to one of two capture shapes:
--
--   - 'account_and_profile' (default) — current behaviour: identity
--     fields + full profile schema, with optional per-submit `partial`
--     opt-in.
--
--   - 'account_only' — identity only (name + phone OR email + consent).
--     Server forces submit_mode=account_only and skips the dispatcher
--     fan-out entirely; client renders MinimalIdentityForm.
--
-- Mode is set at create time and is immutable thereafter (PATCH route
-- already strict-rejects unknown keys, so no schema-level change
-- needed there).
--
-- Column name `submission_mode` (not `onboarding_mode`) avoids
-- collision with the existing OnboardingConfig.modes concept in
-- packages/schema-service which means delivery channel (bulk/qr/link).

ALTER TABLE "registration_links"
  ADD COLUMN IF NOT EXISTS "submission_mode" text
  NOT NULL DEFAULT 'account_and_profile';

DO $$ BEGIN
  ALTER TABLE "registration_links"
    ADD CONSTRAINT "registration_links_submission_mode_check"
    CHECK ("submission_mode" IN ('account_only', 'account_and_profile'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
