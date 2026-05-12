-- Migration 0005 — split the aggregator schema into two tables.
--
--   * `aggregators` (rewritten) — registration-essential identity, Beckn
--     `contact` jsonb + generated `contact_phone` / `contact_email` for
--     auth-path lookups, Beckn `locations`, `consent`, lifecycle `status`,
--     and audit fields. `org_slug` stays the unique business identifier and
--     is enforced immutable by a trigger.
--   * `aggregator_profile` (new) — 1:1 secondary row populated post-login:
--     `contact_name`, `personas`, `services`, `verified_certificate`,
--     and a `profile_completed_at` checkpoint.
--
-- DESTRUCTIVE — this migration assumes a testing-stage deployment:
--   1. DROPs the old `aggregator_profiles` table outright.
--   2. TRUNCATE … CASCADE on `aggregators` (and therefore every FK-referencing
--      child table: `bulk_uploads`, `participants`, `registration_links`,
--      `link_submissions`, `onboarding`).
--   3. DROPs and recreates the `aggregator_type` enum so the new `'both'`
--      member can be added without `ALTER TYPE ADD VALUE` (which doesn't run
--      reliably inside the drizzle migrator's transaction).
--
-- Re-run safety:
--   The script is NOT idempotent. Each statement assumes the previous
--   schema is present. Do not re-apply against a partially-migrated DB —
--   roll forward via a new migration instead.

CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint

-- ─── Wipe and rebuild aggregators identity ──────────────────────────────────

DROP TABLE IF EXISTS "aggregator_profiles";--> statement-breakpoint

TRUNCATE TABLE "aggregators" CASCADE;--> statement-breakpoint

-- aggregator_type: drop, recreate with 'both' member, restore column.
ALTER TABLE "aggregators" DROP COLUMN "type";--> statement-breakpoint
DROP TYPE "public"."aggregator_type";--> statement-breakpoint
CREATE TYPE "public"."aggregator_type" AS ENUM('seeker', 'provider', 'both');--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "type" "public"."aggregator_type";--> statement-breakpoint

-- New enums
CREATE TYPE "public"."aggregator_actor_type" AS ENUM('aggregator', 'seeker', 'provider');--> statement-breakpoint
CREATE TYPE "public"."aggregator_status" AS ENUM('pending', 'active', 'inactive', 'retired');--> statement-breakpoint

-- ─── aggregators: new columns ───────────────────────────────────────────────

ALTER TABLE "aggregators" ADD COLUMN "actor_type" "public"."aggregator_actor_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "contact" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators"
  ADD COLUMN "contact_phone" text GENERATED ALWAYS AS ((contact->>'phone')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators"
  ADD COLUMN "contact_email" text GENERATED ALWAYS AS (lower(contact->>'email')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "locations" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "consent" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "status" "public"."aggregator_status" NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "aggregators" ADD COLUMN "updated_by" text NOT NULL;--> statement-breakpoint

-- ─── aggregators: CHECK constraints ─────────────────────────────────────────

-- type is required for seeker/provider actors, forbidden for aggregator actors.
ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_type_actor_chk" CHECK (
  ("actor_type" = 'aggregator' AND "type" IS NULL)
  OR ("actor_type" IN ('seeker', 'provider') AND "type" IS NOT NULL)
);--> statement-breakpoint

-- Minimum Beckn Contact fields enforced at the DB layer.
ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_contact_shape_chk" CHECK (
  jsonb_typeof("contact") = 'object'
  AND jsonb_typeof("contact"->'name') = 'string'
  AND jsonb_typeof("contact"->'phone') = 'string'
  AND jsonb_typeof("contact"->'email') = 'string'
);--> statement-breakpoint

ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_locations_array_chk" CHECK (
  jsonb_typeof("locations") = 'array'
);--> statement-breakpoint

-- Per-element validation (every location's geo.type ∈ Beckn GeoJSON enum) is
-- enforced at the app layer via Zod. Postgres CHECK constraints cannot
-- contain subqueries, so we cap shape validation at top-level array typing
-- here and rely on the BecknLocationSchema for the element-level check.

ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_consent_shape_chk" CHECK (
  jsonb_typeof("consent"->'value') = 'boolean'
  AND jsonb_typeof("consent"->'given_at') = 'string'
  AND jsonb_typeof("consent"->'valid_till') = 'string'
);--> statement-breakpoint

-- ─── aggregators: indexes ───────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "aggregators_contact_phone_unique" ON "aggregators" USING btree ("contact_phone");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "aggregators_contact_email_unique" ON "aggregators" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregators_status_idx" ON "aggregators" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregators_actor_type_idx" ON "aggregators" USING btree ("actor_type");--> statement-breakpoint

-- ─── aggregator_profile: 1:1 secondary row ──────────────────────────────────

CREATE TABLE IF NOT EXISTS "aggregator_profile" (
  "aggregator_id" uuid PRIMARY KEY REFERENCES "aggregators"("id") ON DELETE CASCADE,
  "contact_name" text,
  "personas" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "services" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "verified_certificate" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "profile_completed_at" timestamptz,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "aggregator_profile_personas_array_chk" CHECK (jsonb_typeof("personas") = 'array'),
  CONSTRAINT "aggregator_profile_services_array_chk" CHECK (jsonb_typeof("services") = 'array'),
  CONSTRAINT "aggregator_profile_verified_certificate_array_chk" CHECK (jsonb_typeof("verified_certificate") = 'array')
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "aggregator_profile_personas_gin" ON "aggregator_profile" USING gin ("personas" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_profile_services_gin" ON "aggregator_profile" USING gin ("services" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aggregator_profile_completed_at_idx" ON "aggregator_profile" USING btree ("profile_completed_at");--> statement-breakpoint

-- ─── Triggers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "set_updated_at"() RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "aggregators_set_updated_at" ON "aggregators";--> statement-breakpoint
CREATE TRIGGER "aggregators_set_updated_at"
BEFORE UPDATE ON "aggregators"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "aggregator_profile_set_updated_at" ON "aggregator_profile";--> statement-breakpoint
CREATE TRIGGER "aggregator_profile_set_updated_at"
BEFORE UPDATE ON "aggregator_profile"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint

-- Lock org_slug: cannot mutate after INSERT. Editing `name` must never
-- regenerate the slug — preserves stable URLs / Keycloak attribute refs.
CREATE OR REPLACE FUNCTION "aggregators_lock_slug"() RETURNS trigger AS $$
BEGIN
  IF NEW."org_slug" IS DISTINCT FROM OLD."org_slug" THEN
    RAISE EXCEPTION 'org_slug is immutable (id=%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "aggregators_lock_slug" ON "aggregators";--> statement-breakpoint
CREATE TRIGGER "aggregators_lock_slug"
BEFORE UPDATE ON "aggregators"
FOR EACH ROW EXECUTE FUNCTION "aggregators_lock_slug"();
