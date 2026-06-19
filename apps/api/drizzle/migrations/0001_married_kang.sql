CREATE TYPE "public"."bulk_upload_status" AS ENUM('pending', 'uploaded', 'file_validating', 'file_failed', 'row_processing', 'finalising', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."participant_type" AS ENUM('seeker', 'provider');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bulk_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"participant_type" "participant_type" NOT NULL,
	"s3_key" text NOT NULL,
	"s3_etag" text NOT NULL,
	"status" "bulk_upload_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"total_rows" integer,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors_csv_s3_key" text,
	"schema_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"last_progress_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bulk_uploads" ADD CONSTRAINT "bulk_uploads_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bulk_uploads_aggregator_etag_unique" ON "bulk_uploads" USING btree ("aggregator_id","s3_etag");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bulk_uploads_status_progress_idx" ON "bulk_uploads" USING btree ("status","last_progress_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bulk_uploads_aggregator_status_idx" ON "bulk_uploads" USING btree ("aggregator_id","status");