-- Migration 0008 — make `registration_links.slug` unique per aggregator
-- instead of globally unique.
--
-- Public registration URLs are moving from `/r/<slug>` to
-- `/<org_slug>/<slug>`, which means two aggregators may legitimately use the
-- same link slug (e.g. both run a "dharwad-bluedothan-may26" drive). The
-- global UNIQUE blocked that — replace it with a composite UNIQUE on
-- (aggregator_id, slug).

DROP INDEX IF EXISTS "registration_links_slug_unique";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "registration_links_aggregator_slug_unique"
  ON "registration_links" USING btree ("aggregator_id", "slug");
