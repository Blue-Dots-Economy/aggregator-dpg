-- Migration 0013 — onboarding lifecycle follow-up.
--
-- Bundles the schema changes introduced by Tasks 1 + 2 of the
-- onboarding-lifecycle-followup plan:
--
--  1. `registration_links.completion_actions` — JSONB array of
--     post-onboarding outbound campaign descriptors. Configured per
--     registration link in the dashboard; consumed by the dispatcher
--     when a participant completes the form.
--
--  2. `outbound_dispatch_log` — audit log of outbound completion
--     sends (sms / voice / chat). The composite unique key
--     (participant_id, item_id, channel, template_id) makes the
--     dispatcher's enqueue idempotent: re-running the planner against
--     the same signals response cannot duplicate sends. A row may
--     transition `queued` → `skipped_lifecycle` when the underlying
--     signals item moves out of `draft` before the send fires.
--
-- Foreign keys both cascade-delete: deleting an aggregator or a
-- participant tombstones their dispatch history.

ALTER TABLE "registration_links" ADD COLUMN "completion_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbound_dispatch_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"channel" text NOT NULL,
	"template_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_dispatch_log" ADD CONSTRAINT "outbound_dispatch_log_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outbound_dispatch_log" ADD CONSTRAINT "outbound_dispatch_log_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_dispatch_idempotency_idx" ON "outbound_dispatch_log" ("participant_id","item_id","channel","template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_dispatch_aggregator_status_idx" ON "outbound_dispatch_log" ("aggregator_id","status");
