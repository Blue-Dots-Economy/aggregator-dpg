-- Migration 0016 — aggregator_consent_record (registration consent ledger).
--
-- Append-only table: one row per registration acceptance, keyed by
-- subject_type + subject_id so the same table covers both org and
-- coordinator/aggregator registration flows (spec §5).
-- No FK on subject_id (polymorphic — app layer already owns the subject row
-- at write time). Index on (subject_type, subject_id) for ledger lookups.

CREATE TABLE IF NOT EXISTS "aggregator_consent_record" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_type"    text NOT NULL,
  "subject_id"      uuid NOT NULL,
  "terms_version"   integer NOT NULL,
  "privacy_version" integer NOT NULL,
  "network"         text NOT NULL,
  "brand"           text,
  "source"          text NOT NULL,
  "accepted_at"     timestamp with time zone NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "aggregator_consent_record_subject_idx"
  ON "aggregator_consent_record" ("subject_type", "subject_id");
