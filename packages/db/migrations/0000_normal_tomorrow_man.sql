CREATE TYPE "public"."onboarding_mode" AS ENUM('link', 'qr', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."target_role" AS ENUM('seeker', 'provider');--> statement-breakpoint
CREATE TYPE "public"."bulk_upload_row_outcome" AS ENUM('success', 'flagged', 'error');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."export_job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "aggregator_profile" (
	"aggregator_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" uuid NOT NULL,
	"values_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aggregator_profile_schema" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"schema_json" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"mode" "onboarding_mode" NOT NULL,
	"target_role" "target_role" NOT NULL,
	"label" text NOT NULL,
	"join_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bulk_upload_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bulk_upload_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_row_json" jsonb NOT NULL,
	"outcome" "bulk_upload_row_outcome" NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_name" text NOT NULL,
	"aggregator_type" text NOT NULL,
	"admin_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"status" "registration_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"filter_json" jsonb NOT NULL,
	"status" "export_job_status" DEFAULT 'pending' NOT NULL,
	"file_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregator_id" uuid NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aggregator_profile" ADD CONSTRAINT "aggregator_profile_schema_version_aggregator_profile_schema_id_fk" FOREIGN KEY ("schema_version") REFERENCES "public"."aggregator_profile_schema"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_link" ADD CONSTRAINT "onboarding_link_aggregator_id_aggregator_profile_aggregator_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregator_profile"("aggregator_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_upload_batch" ADD CONSTRAINT "bulk_upload_batch_aggregator_id_aggregator_profile_aggregator_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregator_profile"("aggregator_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_upload_row" ADD CONSTRAINT "bulk_upload_row_batch_id_bulk_upload_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."bulk_upload_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_aggregator_id_aggregator_profile_aggregator_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregator_profile"("aggregator_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_aggregator_id_aggregator_profile_aggregator_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregator_profile"("aggregator_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aggregator_profile_schema_version" ON "aggregator_profile" USING btree ("schema_version");--> statement-breakpoint
CREATE INDEX "idx_aggregator_profile_schema_active" ON "aggregator_profile_schema" USING btree ("created_at" DESC NULLS LAST) WHERE "aggregator_profile_schema"."active" = true;--> statement-breakpoint
CREATE INDEX "idx_onboarding_link_aggregator_created" ON "onboarding_link" USING btree ("aggregator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_onboarding_link_active_aggregator" ON "onboarding_link" USING btree ("aggregator_id","created_at" DESC NULLS LAST) WHERE "onboarding_link"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_bulk_upload_batch_aggregator_created" ON "bulk_upload_batch" USING btree ("aggregator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_bulk_upload_row_batch_row" ON "bulk_upload_row" USING btree ("batch_id","row_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_registration_request_pending" ON "registration_request" USING btree ("created_at" DESC NULLS LAST) WHERE "registration_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_export_job_aggregator_created" ON "export_job" USING btree ("aggregator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_export_job_pending" ON "export_job" USING btree ("created_at" DESC NULLS LAST) WHERE "export_job"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_audit_log_aggregator_occurred" ON "audit_log" USING btree ("aggregator_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity_occurred" ON "audit_log" USING btree ("entity","entity_id","occurred_at" DESC NULLS LAST);