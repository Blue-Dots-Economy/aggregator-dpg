CREATE TYPE "public"."aggregator_type" AS ENUM('seeker', 'provider');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "aggregator_profiles" (
	"aggregator_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "aggregators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_slug" text NOT NULL,
	"type" "aggregator_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aggregators_org_slug_unique" UNIQUE("org_slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "aggregator_profiles" ADD CONSTRAINT "aggregator_profiles_aggregator_id_aggregators_id_fk" FOREIGN KEY ("aggregator_id") REFERENCES "public"."aggregators"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
