-- Verify migration 0027 (`users`), read-only. Run AFTER the train.
-- Gates (must be 0): V1–V5. Informational: V6. Counts only — never PII.
-- Run by scripts/user-org-migrate.sh verify.
\set ON_ERROR_STOP on

-- The account role, read once. A session-local TEMP VIEW (the one object this
-- script creates), so every check below shares the same definition.
CREATE TEMP VIEW verify_users AS
SELECT u.id, u.contact_id, u.signalstack_org_slug, u.status,
       u.user_type = 'admin' AS is_admin
  FROM users u;

-- V1  orgs whose owner is missing or not an admin account
SELECT 'V1 orgs_without_admin_owner' AS check_id, count(*) AS n
  FROM aggregator_orgs o LEFT JOIN verify_users u ON u.id = o.owner_user_id
 WHERE u.id IS NULL OR NOT u.is_admin;

-- V2  accounts violating the role shape (the CHECK enforces it; a guard)
SELECT 'V2 role_shape_violations' AS check_id, count(*) AS n FROM verify_users
 WHERE (NOT is_admin AND (signalstack_org_slug IS NULL OR status IS NULL))
    OR (is_admin AND (signalstack_org_slug IS NOT NULL OR status IS NOT NULL));

-- V3  contacts referenced by no account (a GC miss)
SELECT 'V3 orphan_contacts' AS check_id, count(*) AS n
  FROM contact c LEFT JOIN verify_users u ON u.contact_id = c.id
 WHERE u.id IS NULL;

-- V4  two accounts for one person in one role (the index enforces it; a guard)
SELECT 'V4 duplicate_accounts' AS check_id, count(*) AS n FROM (
  SELECT contact_id, is_admin FROM verify_users GROUP BY 1, 2 HAVING count(*) > 1) d;

-- V5  admin accounts that own no org (a release missed by aggregator_orgs_owner_ad)
SELECT 'V5 admins_without_org' AS check_id, count(DISTINCT u.id) AS n
  FROM verify_users u LEFT JOIN aggregator_orgs o ON o.owner_user_id = u.id
 WHERE u.is_admin AND o.id IS NULL;

-- V6  (informational) coordinators without a recorded IdP login — `enrich` fills them
SELECT 'V6 coordinators_without_identity' AS check_id, count(DISTINCT u.id) AS n
  FROM verify_users u LEFT JOIN user_identities i ON i.user_id = u.id
 WHERE NOT u.is_admin AND i.user_id IS NULL;
