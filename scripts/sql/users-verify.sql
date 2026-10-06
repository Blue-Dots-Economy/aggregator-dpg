-- Verify migration 0027 (`users`), read-only. Run AFTER the train.
-- Gates (must be 0): V1–V5. Informational: V6. Counts only — never PII.
-- Run by scripts/user-org-migrate.sh verify.
\set ON_ERROR_STOP on

-- V1  orgs whose owner is missing or not an admin account
SELECT 'V1 orgs_without_admin_owner' AS check_id, count(*) AS n
  FROM aggregator_orgs o LEFT JOIN users u ON u.id = o.owner_user_id
 WHERE u.id IS NULL OR u.user_type <> 'admin';

-- V2  accounts violating the role shape (the CHECK enforces it; a guard)
SELECT 'V2 role_shape_violations' AS check_id, count(*) AS n FROM users
 WHERE (user_type = 'coordinator' AND (signalstack_org_slug IS NULL OR status IS NULL))
    OR (user_type = 'admin' AND (signalstack_org_slug IS NOT NULL OR status IS NOT NULL));

-- V3  contacts referenced by no account (a GC miss)
SELECT 'V3 orphan_contacts' AS check_id, count(*) AS n
  FROM contact c WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.contact_id = c.id);

-- V4  two accounts for one person in one role (the index enforces it; a guard)
SELECT 'V4 duplicate_accounts' AS check_id, count(*) AS n FROM (
  SELECT contact_id, user_type FROM users GROUP BY 1, 2 HAVING count(*) > 1) d;

-- V5  admin accounts that own no org (a release missed by aggregator_orgs_owner_ad)
SELECT 'V5 admins_without_org' AS check_id, count(*) AS n FROM users u
 WHERE u.user_type = 'admin'
   AND NOT EXISTS (SELECT 1 FROM aggregator_orgs o WHERE o.owner_user_id = u.id);

-- V6  (informational) coordinators without a recorded IdP login — `enrich` fills them
SELECT 'V6 coordinators_without_identity' AS check_id, count(*) AS n FROM users u
 WHERE u.user_type = 'coordinator'
   AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id);
