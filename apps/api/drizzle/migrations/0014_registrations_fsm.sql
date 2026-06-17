-- Migration 0014 — registrations FSM tables.
--
-- Adds the `registrations` and `registration_transitions` tables that back
-- the redesigned aggregator-registration flow. The `registrations` table is
-- the single source of truth: one row per application, modelled as an
-- explicit forward-only state machine (submitted → verified → approved →
-- active, terminals: rejected / abandoned).
--
-- Key design points:
--   - Partial unique indexes scope email/phone uniqueness to non-terminal
--     states so rejected/abandoned applicants can re-register.
--   - `version` (optimistic lock) + a compare-and-set UPDATE pattern prevent
--     concurrent-transition races without advisory locks.
--   - `reconciler_claimed_at` provides row-level claim-stamp for the
--     reconciler job so it can skip rows already in-progress.
--   - `aggregators` table is UNCHANGED — it only holds graduated (active)
--     orgs; the `registrations.aggregator_id` FK is set at graduation.
--
-- All new columns are nullable or have defaults so the migration is
-- online-safe on a live DB with no in-flight registrations.

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "registration_state" AS ENUM (
    'submitted',
    'verified',
    'approved',
    'rejected',
    'active',
    'abandoned'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "registration_actor" AS ENUM (
    'applicant',
    'admin',
    'reconciler',
    'system'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- ── registrations ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "registrations" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key"          text NOT NULL,
  "state"                    "registration_state" NOT NULL DEFAULT 'submitted',

  -- Contact
  "contact_email"            text NOT NULL,
  "contact_phone"            text NOT NULL,

  -- Organisation fields
  "org_name"                 text NOT NULL,
  "org_type"                 text NOT NULL,
  "org_url"                  text,
  "org_locations"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  "profile_draft"            jsonb NOT NULL DEFAULT '{}'::jsonb,
  "consent"                  jsonb NOT NULL,

  -- Provisioning pointers
  "idp_user_id"              text,
  "signalstack_org_id"       text,
  "aggregator_id"            uuid REFERENCES "aggregators"("id") ON DELETE SET NULL,

  -- Provisioning timestamps
  "verification_sent_at"     timestamptz,
  "verified_at"              timestamptz,
  "admin_notified_at"        timestamptz,
  "approval_link_issued_at"  timestamptz,

  -- Per-projection done/failed flags
  "provision_state"          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optimistic concurrency
  "version"                  integer NOT NULL DEFAULT 0,

  -- Reconciler claim stamp
  "reconciler_claimed_at"    timestamptz,

  -- Audit
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- ── registrations indexes ────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "registrations_idempotency_key_unique"
  ON "registrations" ("idempotency_key");
--> statement-breakpoint

-- Partial unique indexes: email and phone must be unique ONLY among
-- non-terminal registrations. A rejected/abandoned applicant may re-register
-- with the same contact details.
CREATE UNIQUE INDEX IF NOT EXISTS "registrations_contact_email_nonterminal_unique"
  ON "registrations" ("contact_email")
  WHERE "state" NOT IN ('rejected', 'abandoned');
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "registrations_contact_phone_nonterminal_unique"
  ON "registrations" ("contact_phone")
  WHERE "state" NOT IN ('rejected', 'abandoned');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registrations_state_idx"
  ON "registrations" ("state");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registrations_contact_email_idx"
  ON "registrations" ("contact_email");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registrations_contact_phone_idx"
  ON "registrations" ("contact_phone");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registrations_created_at_idx"
  ON "registrations" ("created_at");
--> statement-breakpoint

-- ── registration_transitions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "registration_transitions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "registration_id"   uuid NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
  "from_state"        "registration_state" NOT NULL,
  "to_state"          "registration_state" NOT NULL,
  "actor"             "registration_actor" NOT NULL,
  "reason"            text,
  "at"                timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "registration_transitions_registration_id_idx"
  ON "registration_transitions" ("registration_id");
