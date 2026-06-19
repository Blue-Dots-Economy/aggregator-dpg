-- Migration 0010 — add `signalstack_org_id` to `aggregators`.
--
-- Persists the signalstack organisation id returned by
-- POST /api/v1/admin/aggregator/upsert. Stored alongside the equivalent
-- Keycloak user attribute so the worker process (no KC admin client) and
-- anonymous public-link submission path can resolve the aggregator's
-- `x-acting-org-id` header without an extra KC round-trip.
--
-- Nullable: existing approved aggregators carry NULL until either
--   (a) an admin re-approval triggers the upsert again, or
--   (b) the aggregator's first authenticated API request runs the
--       login-time backfill in `requireApproved`, which writes both the
--       KC attribute and this column.
-- Worker rows + anonymous link submissions whose aggregator still has
-- NULL fail with code `SIGNALSTACK_ORG_NOT_REGISTERED` so the operator
-- sees a deterministic error instead of a silent skip.

ALTER TABLE aggregators
  ADD COLUMN signalstack_org_id TEXT NULL;

COMMENT ON COLUMN aggregators.signalstack_org_id IS
  'Signalstack organisation id (returned by /admin/aggregator/upsert). Mirror of the `signalstack_org_id` Keycloak user attribute. Sent as the per-call `x-acting-org-id` header on participant onboard.';
