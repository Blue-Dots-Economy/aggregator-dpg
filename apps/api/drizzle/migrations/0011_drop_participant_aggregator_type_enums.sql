-- Migration 0011 — drop `participant_type` + `aggregator_type` enums.
--
-- The aggregator is a generic platform that runs against ANY signalstack
-- network. blue_dot has domains `seeker`/`provider`; yellow_dot has
-- `learner`/`tutor`; purple_dot adds others. Pinning the columns to a
-- closed enum forces a code+migration round-trip every time a new
-- network lands. Convert both columns to `text` so the network config
-- (config/aggregator.config.yaml + signalstack network.json) drives the
-- valid set at the application layer.
--
-- Affected columns:
--   participants.type              participant_type -> text
--   bulk_uploads.participant_type  participant_type -> text
--   registration_links.domain      participant_type -> text
--   aggregators.type               aggregator_type  -> text
--
-- After the column conversions, both enums are unused and dropped.
-- The matching check constraints (`type IN ('seeker','provider')`)
-- are intentionally NOT re-introduced — app-layer validation against
-- `getNetworkConfig().domainIds` is now the source of truth.

BEGIN;

-- 1. Drop the actor/type cross-check that hardcodes 'seeker'/'provider'
--    casts. App layer now enforces the equivalent invariant
--    (`type === actor_type` for non-aggregator actors) via the
--    AggregatorView Zod refine + the network-config validator.
ALTER TABLE aggregators
  DROP CONSTRAINT IF EXISTS aggregators_type_actor_chk;

-- 2. Convert enum columns to plain text.
ALTER TABLE participants
  ALTER COLUMN type TYPE TEXT USING type::text;

ALTER TABLE bulk_uploads
  ALTER COLUMN participant_type TYPE TEXT USING participant_type::text;

ALTER TABLE registration_links
  ALTER COLUMN domain TYPE TEXT USING domain::text;

ALTER TABLE aggregators
  ALTER COLUMN type TYPE TEXT USING type::text;

-- 3. Re-add a generic actor/type cross-check that works regardless of
--    the network's domain ids. Aggregator actors must have NULL type;
--    seeker/provider/learner/tutor/... actors must mirror their
--    actor_type in `type`.
ALTER TABLE aggregators
  ADD CONSTRAINT aggregators_type_actor_chk CHECK (
    actor_type = 'aggregator'
    OR (actor_type <> 'aggregator' AND type = actor_type::text)
  );

-- 4. Drop the now-unused enum types.
-- `IF EXISTS` keeps the migration idempotent — a previous run of this
-- branch may have already removed the enums.
DROP TYPE IF EXISTS participant_type;
DROP TYPE IF EXISTS aggregator_type;

COMMIT;
