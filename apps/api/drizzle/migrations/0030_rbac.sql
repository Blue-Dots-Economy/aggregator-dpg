-- Migration 0030 — RBAC grants and per-organisation PermissionSets (R3;
-- design: docs/rbac/rbac-design-aggregator.md, docs/rbac/rbac-implementation-plan.md).
-- * `organisations.permission_set`: an organisation's own PermissionSet name
--   from config/rbac.yaml; NULL = the org_type default. Validated by the API.
-- * `user_permission_grant`: capabilities granted to one user on top of their
--   role (PII Access), with an expiry; at most one live grant per user and key.
-- * `iam_audit`: append-only record of grant and PermissionSet changes.
-- Additive and idempotent; applied at boot after the user & org release train.

SELECT set_config('aggregator_dpg.prev_lock_timeout', current_setting('lock_timeout'), true),
       set_config('aggregator_dpg.prev_statement_timeout', current_setting('statement_timeout'), true);
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0030_rbac'));

-- Run as the table owner (same rule as 0025–0029).
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO v_owner
    FROM pg_class c
   WHERE c.oid = to_regclass('public.users');
  IF v_owner IS DISTINCT FROM current_user THEN
    IF pg_has_role(current_user, v_owner, 'MEMBER') THEN
      EXECUTE format('SET LOCAL ROLE %I', v_owner);
    ELSE
      RAISE EXCEPTION '0030: run as the owner of "users" (%), not as %', v_owner, current_user;
    END IF;
  END IF;
END $$;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS permission_set text;

CREATE TABLE IF NOT EXISTS user_permission_grant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_key   text NOT NULL,
  capability  text NOT NULL,
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT user_permission_grant_expiry_chk CHECK (expires_at > granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_permission_grant_live_unique
  ON user_permission_grant (user_id, grant_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_permission_grant_user_idx ON user_permission_grant (user_id);

CREATE TABLE IF NOT EXISTS iam_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at             timestamptz NOT NULL DEFAULT now(),
  event          text NOT NULL,
  actor_user_id  uuid,
  target_user_id uuid,
  target_org_id  uuid,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS iam_audit_at_idx ON iam_audit (at);

CREATE OR REPLACE FUNCTION iam_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'iam_audit is append-only';
END $$;
DROP TRIGGER IF EXISTS iam_audit_append_only_trg ON iam_audit;
CREATE TRIGGER iam_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON iam_audit
  FOR EACH ROW EXECUTE FUNCTION iam_audit_append_only();

-- Leave the transaction as the role that started it (drizzle writes its
-- metadata right after this file).
RESET ROLE;
SELECT set_config('lock_timeout', current_setting('aggregator_dpg.prev_lock_timeout'), true),
       set_config('statement_timeout', current_setting('aggregator_dpg.prev_statement_timeout'), true);
