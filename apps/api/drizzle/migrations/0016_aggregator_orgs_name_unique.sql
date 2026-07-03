-- Migration 0016 — unique org display_name (case-insensitive, non-terminal rows).
--
-- Mirrors the slug partial-unique index: an org name is unique across pending +
-- active rows, so a rejected/retired org never blocks reusing its name. Applied
-- case-insensitively via lower(display_name). Additive + inert when
-- ORG_HIERARCHY_ENABLED=false (the table stays empty).

CREATE UNIQUE INDEX IF NOT EXISTS "aggregator_orgs_display_name_active_unique"
  ON "aggregator_orgs" (lower("display_name")) WHERE "status" IN ('pending', 'active');
