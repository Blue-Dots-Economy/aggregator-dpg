-- contact-verify.sql — READ-ONLY checks for the `contact` table (migration 0025).
--
-- Run after `scripts/contact-migrate.sh apply`, again after every release of
-- the contact rollout, and before the release that drops the legacy columns.
-- V1–V4 must be 0. Output is counts only — never PII.
--
--   V1  rows with contact data but no contact_id (a conflict the best-effort
--       sync triggers declined to resolve). Gates the legacy-column drop.
--   V2  contacts whose id does not match contact_id_of(email, phone).
--   V3  orphan contacts (referenced by neither table).
--   V4  drift between the legacy columns and the linked contact, while the
--       legacy columns are still written.
--   V5  org-owner contacts with no name (informational; filled from Keycloak
--       by scripts/backfill-owner-contact-names.ts).
--   V6  coordinator rows whose legacy jsonb is NULL (informational: expected
--       to grow once the application stops writing the legacy columns).

SELECT check_id, description, n FROM (
  SELECT 1 AS ord, 'V1' AS check_id, 'coordinators with contact data but no contact_id' AS description,
         (SELECT count(*) FROM aggregators WHERE contact_id IS NULL AND contact IS NOT NULL) AS n
  UNION ALL
  SELECT 2, 'V1', 'orgs with owner email but no contact_id',
         (SELECT count(*) FROM aggregator_orgs WHERE contact_id IS NULL AND owner_email IS NOT NULL)
  UNION ALL
  SELECT 3, 'V2', 'contacts whose id does not match contact_id_of(email, phone)',
         (SELECT count(*) FROM contact WHERE id <> contact_id_of(email, phone))
  UNION ALL
  SELECT 4, 'V3', 'orphan contacts',
         (SELECT count(*) FROM contact c
           WHERE NOT EXISTS (SELECT 1 FROM aggregators a WHERE a.contact_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM aggregator_orgs o WHERE o.contact_id = c.id))
  UNION ALL
  SELECT 5, 'V4', 'coordinators whose legacy contact differs from the linked contact',
         (SELECT count(*) FROM aggregators a JOIN contact c ON c.id = a.contact_id
           WHERE a.contact IS NOT NULL
             AND (lower(btrim(a.contact->>'email')) IS DISTINCT FROM c.email
               OR (a.contact->>'phone') IS DISTINCT FROM c.phone
               OR nullif(btrim(a.contact->>'name'), '') IS DISTINCT FROM c.name
               OR (a.contact - 'name' - 'phone' - 'email') IS DISTINCT FROM a.contact_extra))
  UNION ALL
  SELECT 6, 'V4', 'orgs whose legacy owner email/phone differs from the linked contact',
         (SELECT count(*) FROM aggregator_orgs o JOIN contact c ON c.id = o.contact_id
           WHERE o.owner_email IS NOT NULL
             AND (lower(btrim(o.owner_email)) IS DISTINCT FROM c.email
               OR o.owner_phone IS DISTINCT FROM c.phone))
  UNION ALL
  SELECT 7, 'V5', 'org-owner contacts without a name (informational)',
         (SELECT count(*) FROM aggregator_orgs o JOIN contact c ON c.id = o.contact_id WHERE c.name IS NULL)
  UNION ALL
  SELECT 8, 'V6', 'coordinators with NULL legacy contact jsonb (informational)',
         (SELECT count(*) FROM aggregators WHERE contact IS NULL)
) v
ORDER BY ord;
