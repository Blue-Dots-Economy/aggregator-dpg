-- Migration 0014 — aggregator_orgs (org system of record) + parent_org_id FK.
--
-- Additive + inert when ORG_HIERARCHY_ENABLED=false: the table stays empty and
-- the new column stays null, so behaviour is identical to today (spec §13.2).
-- Reuses the existing aggregator_status enum. Slug uniqueness is partial
-- (non-terminal rows only) so a rejected org never blocks a new slug (spec A9).
-- The org→coordinator link lives ONLY in aggregators.parent_org_id (spec A1);
-- the KC group is a future-authz mirror that no scoping query reads.

CREATE TABLE IF NOT EXISTS "aggregator_orgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "state" text,
  "owner_email" text NOT NULL,
  "owner_kc_sub" text,
  "kc_group_id" text,
  "status" "aggregator_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "parent_org_id" uuid;

DO $$ BEGIN
  ALTER TABLE "aggregators"
    ADD CONSTRAINT "aggregators_parent_org_id_aggregator_orgs_id_fk"
    FOREIGN KEY ("parent_org_id") REFERENCES "aggregator_orgs"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "aggregator_orgs_status_idx" ON "aggregator_orgs" ("status");
CREATE INDEX IF NOT EXISTS "aggregator_orgs_owner_email_idx" ON "aggregator_orgs" ("owner_email");
CREATE UNIQUE INDEX IF NOT EXISTS "aggregator_orgs_slug_active_unique"
  ON "aggregator_orgs" ("slug") WHERE "status" IN ('pending', 'active');
