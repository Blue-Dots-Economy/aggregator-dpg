-- Migration 0006 — relax the actor_type ↔ type invariant.
--
-- Original 0005 enforced "type IS NULL when actor_type='aggregator'" per the
-- canonical Beckn-Aggregator spec note ("type is not applicable when
-- actor_type = aggregator"). Product wants the aggregator's domain focus
-- (seeker / provider / both) captured at signup, so the constraint is
-- loosened to: when actor_type IS 'seeker' or 'provider', `type` must match
-- the actor_type itself; when actor_type IS 'aggregator', any of the three
-- enum values OR NULL is accepted.

ALTER TABLE "aggregators" DROP CONSTRAINT IF EXISTS "aggregators_type_actor_chk";--> statement-breakpoint

ALTER TABLE "aggregators" ADD CONSTRAINT "aggregators_type_actor_chk" CHECK (
  ("actor_type" = 'aggregator')
  OR ("actor_type" = 'seeker' AND "type" = 'seeker')
  OR ("actor_type" = 'provider' AND "type" = 'provider')
);
