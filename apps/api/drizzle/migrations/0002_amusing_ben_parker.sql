CREATE TYPE "public"."link_submission_outcome" AS ENUM('passed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."onboarding_source" AS ENUM('bulk', 'link');--> statement-breakpoint
CREATE TYPE "public"."registration_link_status" AS ENUM('draft', 'live', 'retired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "link_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"participant_id" uuid,
	"metadata_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" "link_submission_outcome" NOT NULL,
	"rolled_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"org_slug" text NOT NULL,
	"source" "onboarding_source" NOT NULL,
	"batch_id" uuid,
	"link_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"total" integer NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"type" "participant_type" NOT NULL,
	"participant_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"phone" text,
	"email" text,
	"source_bulk_upload_id" uuid,
	"source_link_id" uuid,
	"source_row_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registration_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"domain" "participant_type" NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qr_object_key" text,
	"status" "registration_link_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "link_submissions" ADD CONSTRAINT "link_submissions_link_id_registration_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."registration_links"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "link_submissions" ADD CONSTRAINT "link_submissions_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "link_submissions" ADD CONSTRAINT "link_submissions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding" ADD CONSTRAINT "onboarding_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding" ADD CONSTRAINT "onboarding_link_id_registration_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."registration_links"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "participants" ADD CONSTRAINT "participants_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "participants" ADD CONSTRAINT "participants_source_bulk_upload_id_bulk_uploads_id_fk" FOREIGN KEY ("source_bulk_upload_id") REFERENCES "public"."bulk_uploads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "participants" ADD CONSTRAINT "participants_source_link_id_registration_links_id_fk" FOREIGN KEY ("source_link_id") REFERENCES "public"."registration_links"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "registration_links" ADD CONSTRAINT "registration_links_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "link_submissions_rollup_pickup_idx" ON "link_submissions" USING btree ("rolled_up_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "link_submissions_link_idx" ON "link_submissions" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "link_submissions_aggregator_created_idx" ON "link_submissions" USING btree ("aggregator_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_bulk_batch_unique" ON "onboarding" USING btree ("batch_id") WHERE "onboarding"."source" = 'bulk';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_link_rollup_unique" ON "onboarding" USING btree ("aggregator_id","link_id","period_start") WHERE "onboarding"."source" = 'link';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_aggregator_source_idx" ON "onboarding" USING btree ("aggregator_id","source","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_batch_idx" ON "onboarding" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "participants_aggregator_participant_unique" ON "participants" USING btree ("aggregator_id","participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participants_aggregator_phone_idx" ON "participants" USING btree ("aggregator_id","phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participants_source_bulk_idx" ON "participants" USING btree ("source_bulk_upload_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participants_source_link_idx" ON "participants" USING btree ("source_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registration_links_slug_unique" ON "registration_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_links_aggregator_status_idx" ON "registration_links" USING btree ("aggregator_id","status");