-- Migration 0022 — rejected_at cooling window (#726).
--
-- Write-once timestamp of rejection on both registration tables. Set exactly
-- once when a pending registration is rejected (status → inactive); never
-- mutated after. Powers the re-registration cooling window without depending on
-- the mutable updated_at. Additive + nullable: NULL for every existing row.

ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;
ALTER TABLE "aggregator_orgs" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp with time zone;
