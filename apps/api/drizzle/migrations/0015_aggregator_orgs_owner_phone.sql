-- Migration 0015 — aggregator_orgs.owner_phone.
--
-- Additive + nullable. Stores the org owner's contact phone on the org record
-- so the network-admin review email (and the §7 resend path, which has no
-- request body) can show it, matching owner_email. Inert when
-- ORG_HIERARCHY_ENABLED=false (the table stays empty).

ALTER TABLE "aggregator_orgs" ADD COLUMN IF NOT EXISTS "owner_phone" text;
