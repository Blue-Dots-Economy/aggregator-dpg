-- Migration 0025 — `contact` table (user & org management refactor, Phase 1).
--
-- One row per person (name, email, phone), referenced by FK `contact_id` from
-- `aggregators` (coordinators) and `aggregator_orgs` (org owners). The id is the
-- sha-256 of `lower(email):phone` — see `contact_id_of()` below and
-- `@aggregator-dpg/shared-primitives/contact` `contactId()`; the two MUST stay
-- identical (golden-vector tests pin them).
--
-- THIS FILE IS ALSO THE PRE-DEPLOY SCRIPT. On an existing instance ops run it
-- first with `scripts/contact-migrate.sh apply` (psql) against the live DB;
-- drizzle then re-runs it at the next API boot as a no-op that relinks any
-- rows written in between. On a fresh instance only the boot run happens.
-- Everything below is therefore idempotent:
--   CREATE … IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE
--   FUNCTION/TRIGGER, pg_constraint-guarded FKs, WHERE contact_id IS NULL
--   backfills, ON CONFLICT DO NOTHING.
-- Constraints on the file: no BEGIN/COMMIT (drizzle and `psql
-- --single-transaction` supply the transaction), no psql meta-commands, no
-- bind parameters, no statement-breakpoints (it runs as one simple query).
--
-- DEPLOY SAFETY. Additive for the running (N-1) release:
--   * the sync triggers keep `contact` in step with legacy writes to
--     `aggregators.contact` / `aggregator_orgs.owner_email|owner_phone`, and
--     are best-effort — they never fail a legacy write (a conflict leaves the
--     FK NULL and raises a WARNING; `scripts/sql/contact-verify.sql` V1 counts
--     those). Coordinator-vs-coordinator duplicates are still rejected by the
--     legacy `aggregators_contact_{phone,email}_unique` indexes, with the same
--     error codes as before;
--   * the legacy NOT NULLs are relaxed, which N-1 (always writing them) cannot
--     observe, so the later "stop writing legacy columns" release needs no
--     migration of its own.
-- Concurrent runners (several pods booting, or ops + a pod) serialise on the
-- advisory lock below; the second one finds everything in place.
--
-- NOT destructive; nothing is dropped. The legacy columns go in a later
-- migration once no release writes them.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0025_contact'));

-- ─── Version marker ─────────────────────────────────────────────────────────
-- Never silently no-op over a `contact` table this file did not create.
DO $$
BEGIN
  IF to_regclass('public.contact') IS NOT NULL
     AND coalesce(obj_description(to_regclass('public.contact'), 'pg_class'), '') <> 'contact-schema:v1' THEN
    RAISE EXCEPTION '0025_contact: table "contact" exists without the contact-schema:v1 marker; refusing to continue';
  END IF;
END $$;

-- ─── Hash ───────────────────────────────────────────────────────────────────
-- Inputs are expected canonical (email lowercased/trimmed, phone as produced by
-- normalisePhone). The email is re-normalised defensively; the phone is not.
CREATE OR REPLACE FUNCTION contact_id_of(p_email text, p_phone text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$fn$ SELECT encode(sha256(convert_to(lower(btrim(p_email)) || ':' || coalesce(p_phone, ''), 'UTF8')), 'hex') $fn$;

-- ─── Pre-flight guard (fatal only on FIRST creation) ────────────────────────
-- A re-run after the pre-deploy script must never crash-loop the API boot, so
-- once the table exists this only reports. Counts only — never PII.
DO $$
DECLARE
  n_email int;
  n_phone int;
  n_fmt   int;
BEGIN
  IF to_regclass('public.contact') IS NULL THEN
    WITH src AS (
      SELECT lower(btrim(contact->>'email')) AS e, contact->>'phone' AS p FROM aggregators
      UNION ALL
      SELECT lower(btrim(owner_email)), owner_phone FROM aggregator_orgs
    )
    SELECT
      (SELECT count(*) FROM (SELECT e FROM src GROUP BY e HAVING count(DISTINCT coalesce(p, '')) > 1) a),
      (SELECT count(*) FROM (SELECT p FROM src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e) > 1) b),
      (SELECT count(*) FROM src WHERE (p IS NOT NULL AND p !~ '^\+[0-9]{10,15}$') OR coalesce(e, '') = '')
    INTO n_email, n_phone, n_fmt;
    IF n_email + n_phone + n_fmt > 0 THEN
      RAISE EXCEPTION '0025_contact pre-flight failed: email_with_many_phones=% phone_with_many_emails=% bad_format=% — run scripts/contact-migrate.sh preflight',
        n_email, n_phone, n_fmt;
    END IF;
  END IF;
END $$;

-- ─── contact ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact (
  id         text PRIMARY KEY
             CONSTRAINT contact_id_hex_chk CHECK (id ~ '^[0-9a-f]{64}$'),
  email      text NOT NULL
             CONSTRAINT contact_email_chk CHECK (email = lower(btrim(email)) AND email <> ''),
  phone      text
             CONSTRAINT contact_phone_chk CHECK (phone IS NULL OR phone ~ '^\+[0-9]{10,15}$'),
  name       text
             CONSTRAINT contact_name_chk CHECK (name IS NULL OR btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_id_matches_chk CHECK (id = contact_id_of(email, phone))
);
COMMENT ON TABLE contact IS 'contact-schema:v1';

-- One person per email and per phone, across coordinators AND org owners.
CREATE UNIQUE INDEX IF NOT EXISTS contact_email_unique ON contact (email);
CREATE UNIQUE INDEX IF NOT EXISTS contact_phone_unique ON contact (phone) WHERE phone IS NOT NULL;

CREATE OR REPLACE TRIGGER contact_set_updated_at
  BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── FK columns ─────────────────────────────────────────────────────────────
ALTER TABLE aggregators     ADD COLUMN IF NOT EXISTS contact_id text;
-- Optional Beckn contact keys (alternatePhone, company, gstNumber) — not
-- identity, so not on `contact`; the API composes them back into `contact`.
ALTER TABLE aggregators     ADD COLUMN IF NOT EXISTS contact_extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE aggregator_orgs ADD COLUMN IF NOT EXISTS contact_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'aggregators_contact_id_fk'
                    AND conrelid = 'public.aggregators'::regclass) THEN
    ALTER TABLE aggregators ADD CONSTRAINT aggregators_contact_id_fk
      FOREIGN KEY (contact_id) REFERENCES contact (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'aggregator_orgs_contact_id_fk'
                    AND conrelid = 'public.aggregator_orgs'::regclass) THEN
    ALTER TABLE aggregator_orgs ADD CONSTRAINT aggregator_orgs_contact_id_fk
      FOREIGN KEY (contact_id) REFERENCES contact (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'aggregators_contact_extra_object_chk'
                    AND conrelid = 'public.aggregators'::regclass) THEN
    ALTER TABLE aggregators ADD CONSTRAINT aggregators_contact_extra_object_chk
      CHECK (jsonb_typeof(contact_extra) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS aggregators_contact_id_idx     ON aggregators (contact_id);
CREATE INDEX IF NOT EXISTS aggregator_orgs_contact_id_idx ON aggregator_orgs (contact_id);

-- ─── Relax legacy NOT NULLs (idempotent by nature) ──────────────────────────
-- A stored generated column over a NULL jsonb is NULL, so both generated
-- columns must allow it too.
ALTER TABLE aggregators
  ALTER COLUMN contact       DROP NOT NULL,
  ALTER COLUMN contact_phone DROP NOT NULL,
  ALTER COLUMN contact_email DROP NOT NULL;
ALTER TABLE aggregator_orgs ALTER COLUMN owner_email DROP NOT NULL;

-- ─── Sync + GC functions (all best-effort) ──────────────────────────────────

-- Returns the id of the contact for (email, phone), inserting it when absent.
-- Existing name wins on insert paths. Returns NULL (with a WARNING, no PII)
-- when the pair cannot be linked — invalid input or a unique conflict with a
-- different person — so the caller's write still succeeds.
CREATE OR REPLACE FUNCTION contact_link(p_email text, p_phone text, p_name text) RETURNS text
  LANGUAGE plpgsql AS
$fn$
DECLARE
  v_email text := lower(btrim(p_email));
  v_name  text := nullif(btrim(p_name), '');
  v_id    text;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RETURN NULL;
  END IF;
  IF p_phone IS NOT NULL AND p_phone !~ '^\+[0-9]{10,15}$' THEN
    RAISE WARNING 'contact_link: non-canonical phone; row left unlinked';
    RETURN NULL;
  END IF;
  v_id := contact_id_of(v_email, p_phone);
  BEGIN
    INSERT INTO contact (id, email, phone, name)
    VALUES (v_id, v_email, p_phone, v_name)
    ON CONFLICT DO NOTHING;
    IF v_name IS NOT NULL THEN
      UPDATE contact SET name = v_name WHERE id = v_id AND name IS NULL;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'contact_link: % (%); row left unlinked', SQLERRM, SQLSTATE;
    RETURN NULL;
  END;
  IF EXISTS (SELECT 1 FROM contact WHERE id = v_id) THEN
    RETURN v_id;
  END IF;
  RAISE WARNING 'contact_link: email or phone already belongs to another contact; row left unlinked';
  RETURN NULL;
END;
$fn$;

-- Deletes a contact nothing references any more.
CREATE OR REPLACE FUNCTION contact_gc(p_id text) RETURNS void
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF p_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    DELETE FROM contact c
     WHERE c.id = p_id
       AND NOT EXISTS (SELECT 1 FROM aggregators     a WHERE a.contact_id = p_id)
       AND NOT EXISTS (SELECT 1 FROM aggregator_orgs o WHERE o.contact_id = p_id);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- a concurrent insert re-referenced it; keep the row
  END;
END;
$fn$;

-- Moves one referencing row from its current contact to (email, phone, name).
-- p_table is 'aggregators' or 'aggregator_orgs'. Rules (plan §3.3):
--   same id            → name sync only (explicit update: new name wins)
--   target id exists   → repoint to it, GC the old row
--   no current contact → link
--   old contact shared → link a new contact for this row only
--   otherwise          → re-key the old row in place (FK cascades)
-- Any conflict leaves the row unlinked with a WARNING instead of failing.
CREATE OR REPLACE FUNCTION contact_move(
  p_table text, p_row_id uuid, p_old_id text, p_email text, p_phone text, p_name text
) RETURNS void
  LANGUAGE plpgsql AS
$fn$
DECLARE
  v_email  text := lower(btrim(p_email));
  v_name   text := nullif(btrim(p_name), '');
  v_new    text;
  v_shared boolean;
BEGIN
  IF p_table NOT IN ('aggregators', 'aggregator_orgs') THEN
    RAISE EXCEPTION 'contact_move: unsupported table %', p_table;
  END IF;

  IF v_email IS NULL OR v_email = '' OR (p_phone IS NOT NULL AND p_phone !~ '^\+[0-9]{10,15}$') THEN
    EXECUTE format('UPDATE %I SET contact_id = NULL WHERE id = $1', p_table) USING p_row_id;
    RAISE WARNING 'contact_move: invalid email/phone on %; row left unlinked', p_table;
    PERFORM contact_gc(p_old_id);
    RETURN;
  END IF;

  v_new := contact_id_of(v_email, p_phone);

  IF p_old_id IS NOT DISTINCT FROM v_new THEN
    IF v_name IS NOT NULL THEN
      UPDATE contact SET name = v_name WHERE id = v_new AND name IS DISTINCT FROM v_name;
    END IF;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM contact WHERE id = v_new) THEN
    EXECUTE format('UPDATE %I SET contact_id = $1 WHERE id = $2', p_table) USING v_new, p_row_id;
    IF v_name IS NOT NULL THEN
      UPDATE contact SET name = v_name WHERE id = v_new AND name IS DISTINCT FROM v_name;
    END IF;
    PERFORM contact_gc(p_old_id);
    RETURN;
  END IF;

  IF p_old_id IS NULL THEN
    EXECUTE format('UPDATE %I SET contact_id = contact_link($1, $2, $3) WHERE id = $4', p_table)
      USING v_email, p_phone, v_name, p_row_id;
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM aggregators     WHERE contact_id = p_old_id AND NOT (p_table = 'aggregators'     AND id = p_row_id))
      OR EXISTS (SELECT 1 FROM aggregator_orgs WHERE contact_id = p_old_id AND NOT (p_table = 'aggregator_orgs' AND id = p_row_id))
    INTO v_shared;

  IF v_shared THEN
    EXECUTE format('UPDATE %I SET contact_id = contact_link($1, $2, $3) WHERE id = $4', p_table)
      USING v_email, p_phone, v_name, p_row_id;
    RETURN;
  END IF;

  BEGIN
    UPDATE contact
       SET id = v_new, email = v_email, phone = p_phone, name = coalesce(v_name, name)
     WHERE id = p_old_id;
  EXCEPTION WHEN others THEN
    EXECUTE format('UPDATE %I SET contact_id = NULL WHERE id = $1', p_table) USING p_row_id;
    RAISE WARNING 'contact_move: re-key failed on % (%); row left unlinked', p_table, SQLSTATE;
  END;
END;
$fn$;

-- ─── aggregators triggers ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aggregators_contact_bi() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.contact IS NOT NULL THEN
    IF NEW.contact_id IS NULL THEN
      NEW.contact_id := contact_link(NEW.contact->>'email', NEW.contact->>'phone', NEW.contact->>'name');
    END IF;
    NEW.contact_extra := NEW.contact - 'name' - 'phone' - 'email';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION aggregators_contact_bu() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.contact IS NOT NULL THEN
    NEW.contact_extra := NEW.contact - 'name' - 'phone' - 'email';
  END IF;
  RETURN NEW;
END;
$fn$;

-- AFTER, not BEFORE: a re-key cascades onto this very row, which a BEFORE
-- trigger would see as "tuple already modified".
CREATE OR REPLACE FUNCTION aggregators_contact_au() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.contact IS NOT NULL THEN
    PERFORM contact_move('aggregators', NEW.id, NEW.contact_id,
                         NEW.contact->>'email', NEW.contact->>'phone', NEW.contact->>'name');
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION aggregators_contact_ad() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  PERFORM contact_gc(OLD.contact_id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE TRIGGER aggregators_contact_bi
  BEFORE INSERT ON aggregators
  FOR EACH ROW EXECUTE FUNCTION aggregators_contact_bi();
CREATE OR REPLACE TRIGGER aggregators_contact_bu
  BEFORE UPDATE OF contact ON aggregators
  FOR EACH ROW EXECUTE FUNCTION aggregators_contact_bu();
CREATE OR REPLACE TRIGGER aggregators_contact_au
  AFTER UPDATE OF contact ON aggregators
  FOR EACH ROW WHEN (OLD.contact IS DISTINCT FROM NEW.contact)
  EXECUTE FUNCTION aggregators_contact_au();
CREATE OR REPLACE TRIGGER aggregators_contact_ad
  AFTER DELETE ON aggregators
  FOR EACH ROW EXECUTE FUNCTION aggregators_contact_ad();

-- ─── aggregator_orgs triggers ───────────────────────────────────────────────
-- Legacy org writes carry no owner name (it only ever reached Keycloak); the
-- application sets `contact.name` separately.

CREATE OR REPLACE FUNCTION aggregator_orgs_contact_bi() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.owner_email IS NOT NULL AND NEW.contact_id IS NULL THEN
    NEW.contact_id := contact_link(NEW.owner_email, NEW.owner_phone, NULL);
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION aggregator_orgs_contact_au() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  IF NEW.owner_email IS NOT NULL THEN
    PERFORM contact_move('aggregator_orgs', NEW.id, NEW.contact_id,
                         NEW.owner_email, NEW.owner_phone, NULL);
  END IF;
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION aggregator_orgs_contact_ad() RETURNS trigger
  LANGUAGE plpgsql AS
$fn$
BEGIN
  PERFORM contact_gc(OLD.contact_id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE TRIGGER aggregator_orgs_contact_bi
  BEFORE INSERT ON aggregator_orgs
  FOR EACH ROW EXECUTE FUNCTION aggregator_orgs_contact_bi();
CREATE OR REPLACE TRIGGER aggregator_orgs_contact_au
  AFTER UPDATE OF owner_email, owner_phone ON aggregator_orgs
  FOR EACH ROW WHEN (OLD.owner_email IS DISTINCT FROM NEW.owner_email
                     OR OLD.owner_phone IS DISTINCT FROM NEW.owner_phone)
  EXECUTE FUNCTION aggregator_orgs_contact_au();
CREATE OR REPLACE TRIGGER aggregator_orgs_contact_ad
  AFTER DELETE ON aggregator_orgs
  FOR EACH ROW EXECUTE FUNCTION aggregator_orgs_contact_ad();

-- ─── Backfill (set-based, tolerant, does NOT bump updated_at) ───────────────
-- The prune and cooling windows key off aggregators.updated_at, so the
-- set_updated_at trigger is disabled for the backfill only. aggregator_orgs has
-- no such trigger. DISTINCT ON (id) keeps one source row per id (a person who
-- is both a coordinator and an org owner) — coordinator first, named first.
ALTER TABLE aggregators DISABLE TRIGGER aggregators_set_updated_at;

INSERT INTO contact (id, email, phone, name)
SELECT DISTINCT ON (id) id, e, p, n
  FROM (
    SELECT contact_id_of(contact->>'email', contact->>'phone') AS id,
           lower(btrim(contact->>'email'))                     AS e,
           contact->>'phone'                                   AS p,
           nullif(btrim(contact->>'name'), '')                 AS n,
           0                                                   AS prio
      FROM aggregators
     WHERE contact_id IS NULL AND contact IS NOT NULL
       AND coalesce(btrim(contact->>'email'), '') <> ''
       AND (contact->>'phone' IS NULL OR contact->>'phone' ~ '^\+[0-9]{10,15}$')
    UNION ALL
    SELECT contact_id_of(owner_email, owner_phone),
           lower(btrim(owner_email)),
           owner_phone,
           NULL,
           1
      FROM aggregator_orgs
     WHERE contact_id IS NULL AND owner_email IS NOT NULL
       AND btrim(owner_email) <> ''
       AND (owner_phone IS NULL OR owner_phone ~ '^\+[0-9]{10,15}$')
  ) s
 ORDER BY id, prio, n NULLS LAST
ON CONFLICT DO NOTHING;

UPDATE aggregators a
   SET contact_id    = c.id,
       contact_extra = a.contact - 'name' - 'phone' - 'email'
  FROM contact c
 WHERE a.contact_id IS NULL
   AND a.contact IS NOT NULL
   AND c.id = contact_id_of(a.contact->>'email', a.contact->>'phone');

UPDATE aggregator_orgs o
   SET contact_id = c.id
  FROM contact c
 WHERE o.contact_id IS NULL
   AND o.owner_email IS NOT NULL
   AND c.id = contact_id_of(o.owner_email, o.owner_phone);

ALTER TABLE aggregators ENABLE TRIGGER aggregators_set_updated_at;

-- ─── Report ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  SELECT (SELECT count(*) FROM aggregators     WHERE contact_id IS NULL AND contact IS NOT NULL)
       + (SELECT count(*) FROM aggregator_orgs WHERE contact_id IS NULL AND owner_email IS NOT NULL)
    INTO n;
  IF n > 0 THEN
    RAISE WARNING '0025_contact: % row(s) left unlinked (conflicts) — see scripts/sql/contact-verify.sql V1', n;
  END IF;
END $$;

-- Hand the rest of the transaction (later migrations in the same drizzle run)
-- back its normal timeouts.
SET LOCAL lock_timeout = DEFAULT;
SET LOCAL statement_timeout = DEFAULT;
