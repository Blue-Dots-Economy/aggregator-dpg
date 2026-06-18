-- Migration 0015 — registration idempotency hardening.
--
-- Adds the schema changes required to fix the idempotency / concurrency
-- gaps identified in PR #426 review. All additions are nullable or have
-- DEFAULT values — no backfill required; online-safe on a live DB.
--
-- Changes:
--   aggregators:     +source_registration_id  (graduation idempotency key, #4)
--   registrations:   +provision_attempts      (backoff / dead-letter tracking, #3)
--   registrations:   +welcome_sent_at         (double-send guard, #6)
--   registrations:   +rejection_sent_at       (double-send guard, #6)
--   indexes:          partial UNIQUE on aggregators.source_registration_id (#4)
--                     partial index on registrations.reconciler_claimed_at (#11)

-- ── aggregators ────────────────────────────────────────────────────────────────

-- #4: idempotent graduation — one aggregator row per registration.
-- The application inserts with ON CONFLICT (source_registration_id) DO NOTHING
-- so a partial-success retry can never create a second aggregator row.
ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "source_registration_id" uuid;
--> statement-breakpoint

-- Partial UNIQUE: NULL is excluded so pre-FSM rows without a registration
-- source coexist without violating the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "aggregators_source_registration_id_unique"
  ON "aggregators" ("source_registration_id")
  WHERE "source_registration_id" IS NOT NULL;
--> statement-breakpoint

-- ── registrations ─────────────────────────────────────────────────────────────

-- #3: per-step attempt counters for exponential backoff and dead-lettering.
-- Shape: { "<key>": { "attempts": n, "last_attempt_at": "<iso>" } }
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "provision_attempts" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- #6: sent-guard timestamps for welcome and rejection emails.
-- Mirror the existing verification_sent_at / admin_notified_at pattern.
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "welcome_sent_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN IF NOT EXISTS "rejection_sent_at" timestamptz;
--> statement-breakpoint

-- ── indexes ───────────────────────────────────────────────────────────────────

-- #11: partial index on reconciler_claimed_at for claim-query performance.
-- Only non-NULL values (i.e. rows currently claimed) need to be indexed —
-- the reconciler queries WHERE reconciler_claimed_at IS NOT NULL or by exact value.
CREATE INDEX IF NOT EXISTS "registrations_reconciler_claimed_at_idx"
  ON "registrations" ("reconciler_claimed_at")
  WHERE "reconciler_claimed_at" IS NOT NULL;
