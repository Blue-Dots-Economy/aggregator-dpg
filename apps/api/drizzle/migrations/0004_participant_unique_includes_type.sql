-- Replaces the (aggregator_id, participant_id) UNIQUE with one that also
-- includes `type`, so a seeker and a provider can share the same external
-- participant_id under one aggregator without colliding on dedup.
DROP INDEX IF EXISTS "participants_aggregator_participant_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "participants_aggregator_type_participant_unique" ON "participants" USING btree ("aggregator_id","type","participant_id");
