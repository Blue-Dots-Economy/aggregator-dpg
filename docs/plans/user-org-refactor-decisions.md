# Decisions log — User & Org management refactor

**Branch:** `refactor/user-org-management` (from `feature` @ `1f31f6b`), in the worktree `../aggregator-dpg-user-org`
**Purpose:** Every decision taken while implementing without you. Each one lists the options considered, the choice, and why. Items marked **⚠ REVIEW** are the ones most worth a second look.
**Companion plan:** `docs/plans/contact-table-phase-1.md`

> Delete this file together with the plan once the refactor has shipped (repo convention for `docs/plans/`).

---

## Decisions you made (2026-09-30)

| #   | Decision                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | **Contact.** A `contact` table with `id`, `email`, `phone`, `name`. The id is sha256 of `lower(email):phone`.                                                     |
| U2  | **FK naming.** Every FK to it is named `contact_id`. Only a second FK in the same table takes a role prefix.                                                      |
| U3  | **Phone uniqueness.** One phone per person across coordinators and org owners. The case of a coordinator who is also an org contact is handled separately, later. |
| U4  | **Hash input.** Exactly `lower(email):phone`.                                                                                                                     |
| U5  | **Side bugs.** They became separate issues: #822, #823, #824.                                                                                                     |
| U6  | **CI.** Add a Postgres service to CI.                                                                                                                             |
| U7  | **Existing instances.** A pre-deploy migration script creates and pre-populates `contact`. The drizzle migration is idempotent (`IF NOT EXISTS`).                 |
| U8  | **Branching.** One branch for all phases. The five local-setup edits sit in the worktree uncommitted and are never staged.                                        |

---

## Phase 1 — decisions taken during implementation

### D1. The migration file IS the pre-deploy script

- **Options considered:**
  - (a) A separate script plus a separate migration.
  - (b) One file, run both by `psql` and by drizzle.
- **Chosen:** (b). `apps/api/drizzle/migrations/0025_contact.sql` is run by `scripts/contact-migrate.sh apply` and again, as a no-op, at the next API boot.
- **Why:** There is no second copy that can drift. Drizzle never compares file hashes, only a `when` high-water mark, so a pre-applied file is harmless.

### D2. ⚠ REVIEW — Journal `when` = `1790800000000`, not "just after 0024"

- **What was found:** Your local `aggregator` DB records a migration at `when=1790700000000`. That is an earlier version of 0024 from commit `9ef5904`, and it was **applied twice** (rows 25 and 26).
- **Why that matters:** Drizzle skips any migration whose `when` is at or below that value. A 0025 stamped `1790696…` would therefore **never run** on such a DB.
- **Chosen:** `1790800000000`, which clears it.
- **Also:** the double application is live evidence of the missing migration lock (see D3).

### D3. Advisory lock + lock/statement timeouts inside 0025

- **Why:** Drizzle's pg migrator takes no lock, and HPA and multi-pod boots race.
- **Chosen:** `pg_advisory_xact_lock(hashtext('aggregator-dpg:0025_contact'))` plus `lock_timeout 5s` and `statement_timeout 300s`. Both timeouts are reset at the end of the file, so later migrations in the same run are not affected.

### D4. The sync triggers are best-effort; they never fail a legacy write

- **Rule:** When a legacy write (from release N−1 during a rollout, or from the running release after the script) cannot be linked, the FK is left NULL and a `WARNING` is raised. The write still succeeds.
- **Why:** Anything stricter would change live behaviour the moment the script runs. For example, some 409s would become 503s (review B3).
- **What still guards duplicates:**
  - Coordinator duplicates are still caught by the legacy unique indexes, with the same constraint names and therefore the same error codes. The integration test pins this.
  - The new cross-role rule is enforced by app pre-checks (D7).
- `scripts/sql/contact-verify.sql` V1 counts rows left unlinked.

### D5. ⚠ REVIEW — R1 keeps the app's WRITE path on the legacy columns; R1 switches READS only

- **Plan said:** in R1 the app writes `contact` first, then dual-writes the legacy columns.
- **Chosen instead:**
  - **R1:** the app still writes only the legacy columns (unchanged code paths), and the database triggers maintain `contact`. All reads come from the `contact` join. There are also new pre-checks and the owner name.
  - **R2:** the app writes `contact` directly and stops writing the legacy columns.
- **Why:**
  - Each release changes one direction only (reads, then writes), so R1 is a much smaller behavioural diff.
  - The triggers are already needed for N−1, so relying on them in R1 adds no new mechanism.
  - Rolling back from R1 is trivially safe.

### D6. No `ContactStore` in R1

- **Why:** The only R1 need is the org-create pre-check, and it is served by the existing `aggregatorStore.findByContactEmail`/`findByContactPhone` plus a new `orgStore.findByOwnerPhone`.
- **When it arrives:** `ContactStore` (link/change) comes in R2, when the app starts writing `contact`.

### D7. Org create gets contact pre-checks, run before any write

- **Checks:**
  - **Email held by a coordinator:** returns `409 OWNER_ALREADY_REGISTERED`.
    - This is the **same** code the Keycloak `USER_EXISTS` branch already returned.
    - Before, that branch ran only after the org row and Keycloak group had been created, and it left an inactive org row behind.
    - Now nothing is written. This is a strict improvement.
  - **Phone held by a coordinator, or by a different org's owner:** returns `409 PHONE_EXISTS`.
    - This is your U3 decision. It is the one intended behaviour change in Phase 1.
- **Not changed:** coordinator registration already checked the owner's phone through the Keycloak `phoneNumber` attribute.

### D8. The owner name is persisted at org create (fixes P3)

- **How:** `CreateOrgInput.ownerName`. Inside the same transaction as the insert, `contact.name` is set if it is still NULL; an existing name wins.
- **Existing owners:** filled by the one-off `apps/api/scripts/backfill-owner-contact-names.ts`, which reads Keycloak first/last name by `owner_kc_sub`. It supports `--dry-run`, is idempotent, and retries once.

### D9. `contact_extra jsonb` on `aggregators`

- **What it holds:** `alternatePhone`, `company`, `gstNumber`. These are part of the API's `contact` object but are not identity.
- **How the response is composed:** `{name, email, phone, ...extras}`, in the **same key order** the legacy jsonb produced (Postgres orders jsonb keys by length, then bytes), so responses stay byte-identical. A unit test covers this.

### D10. Legacy columns relaxed to nullable in 0025, not in a later migration

- **Why:**
  - It is invisible to N−1, which always writes these columns.
  - It makes R2 migration-free, so R2 can roll back to R1 freely.
- **Drizzle types:** also made nullable now, so the compiler forces every read to handle NULL.

### D11. Reads fall back to the legacy columns while they exist

- **Rule:** `findByContactEmail`/`Phone` and `findByOwnerEmail`/`Phone` match the linked contact **OR** (when `contact_id IS NULL`) the legacy column.
- **Why:** A duplicate or reclaim check must never miss an unlinked straggler.
- **Removal:** the fallback is removed in R3 together with the columns.

### D12. Every store write re-reads the row

- **Why:** The AFTER UPDATE trigger can re-key the contact after the statement's `RETURNING` has already been produced.
- **Cost:** one extra indexed `SELECT` per write.

### D13. Contact id treated as PII

- **Rule:** It is never logged, never sent to telemetry and never put in a URL.
- **Warnings:** trigger warnings carry no values.
- **Scripts:** pre-flight and verify print ids and counts only.

### D14. Shared-contact re-key (corrected after review)

- **Case:** One person is both a coordinator and an org owner, and one role changes phone.
- **What happens:** The trigger tries to give that role a new contact of its own via `contact_link`. The review showed this **can only succeed when the email changes too**: after a phone-only change, the email is still held by the shared contact. So in practice the changing row is left unlinked with a WARNING, and the other role is never silently changed.
- **When it happens:** It is unreachable today, because `OWNER_ALREADY_REGISTERED` blocks it, and since the review fixes the profile PATCH pre-check rejects a phone held by an org owner. The proper model (one contact, two roles) is Phase 2.

### D15. ⚠ REVIEW — CI `db-integration` job is **advisory** at first

- **What it does:** A separate job with a `postgres:16` service. It migrates a fresh DB (the fresh-instance path), then runs `*.integration.test.ts`.
- **Why advisory:** It is a new moving part. `docs/ci-required-checks.md` says to promote it to required after a few green PRs.
- **What you need to do:** Promoting it is your branch-protection change; I cannot make it.

### D16. Nothing is pushed

- **Commits:** local commits on `refactor/user-org-management` only.
- **Not done:** no push, no PR, no release tag. Those are outward-facing and wait for you.

### D17. R2 contact writes live in a shared Postgres helper, not a `ContactStore` class

- **Where:** `apps/api/src/db/contact-writes.ts` (`linkContact`, `changeContact`, `gcContact`). Both Postgres stores call these **inside their own transaction**.
- **Why:**
  - The contact write and the FK write must be atomic.
  - The interface rules forbid leaking a Drizzle transaction handle through an abstract contract.
  - No caller outside the two stores writes contacts.
  - The in-memory stores keep computing `contactId` as before.

### D18. R2 writes are strict, where the R0 triggers were best-effort

- **Behaviour:** An app write that clashes with another person's email or phone raises the DB unique violation. The stores map it to `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`, and the routes map those to today's codes (coordinator: `USER_EXISTS` / `PHONE_EXISTS`; org create: `OWNER_ALREADY_REGISTERED` / `PHONE_EXISTS`).
- **Why:** The pre-checks catch clashes first. The strict write closes the race between check and insert.

### D19. ⚠ REVIEW — Re-keying a shared contact is refused with `409 CONFLICT`

- **When:** The contact is shared by a coordinator and an org owner, and one role changes phone.
- **What happens:** `changeContact` throws `SharedContactError`. The aggregator store maps it to `DUPLICATE`, and profile PATCH maps that to `409 CONFLICT`.
- **Why:** Changing it would silently change the other role's phone while Keycloak does not follow.
- **When it applies:** It is unreachable today (see D14). Phase 2 (one contact, two roles) gives this a proper flow.

### D20. R2 clears the legacy copy on a contact change

- **Behaviour:** A contact change also sets the legacy `contact` jsonb (or `owner_email` / `owner_phone`) to NULL.
- **Why:** During the rollout, the legacy unique indexes still exist. A stale legacy copy would block someone else from reusing the old email or phone through an R1 pod.

---

## Review round 1 (R0/R1) — findings and fixes

An independent review agent reproduced every SQL claim on scratch databases. All findings were fixed in the follow-up commit.

| Finding                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1.** A failed trigger re-key left the old contact orphaned, blocking that person's email/phone forever.                                                                                            | `contact_move` now calls `contact_gc(old)` in its failure branch. Covered by an integration test.                                                                                                                                                                                    |
| **B2.** Running the pre-deploy script as an admin/superuser DSN made the new objects owned by that role. The app then got `permission denied`, legacy writes failed and the boot re-run crash-looped. | 0025 now switches to the owner of `aggregators` via `SET LOCAL ROLE` when the caller may, and refuses any other role. Verified with a non-superuser owner role plus a superuser apply, and with a non-member role being refused.                                                     |
| **M1.** A re-run of 0025 could deadlock live legacy writes (lock-order inversion).                                                                                                                    | 0025 takes `LOCK TABLE aggregators, aggregator_orgs` first, which is the same order live writes use.                                                                                                                                                                                 |
| **M2.** The email/phone lookups (the OTP and duplicate-check paths) became sequential scans.                                                                                                          | Rewritten as `contact_id = (subselect) OR (unlinked AND legacy = v)`. An integration test asserts the index is used.                                                                                                                                                                 |
| **M3.** Trimmed names (and lowercased emails) changed the API output for some existing rows.                                                                                                          | Names are stored **verbatim**; only a blank name becomes NULL. Emails stay lowercased because they are identity. Pre-flight now reports rows whose output would change (`mixed_case_email`, `blank_coordinator_name`). A byte-identical `JSON.stringify` integration test was added. |
| Minor: a GC-vs-link race could fail a legacy insert.                                                                                                                                                  | `contact_link` takes `FOR KEY SHARE` and retries once. The TS `linkContact` does the same.                                                                                                                                                                                           |
| Minor: `EXCEPTION WHEN others` hid systemic errors.                                                                                                                                                   | Narrowed to unique/check/FK violations.                                                                                                                                                                                                                                              |
| Minor: the org-create phone pre-check counted half-created orgs.                                                                                                                                      | `findByOwnerPhone` ignores `inactive` orgs that have no Keycloak owner.                                                                                                                                                                                                              |
| Minor: profile PATCH had no cross-role phone check.                                                                                                                                                   | `PHONE_EXISTS` is now returned before any Keycloak write. For a clash with another coordinator this is the same code as before; for a clash with an org owner it is new (U3).                                                                                                        |
| Minor: `SET LOCAL … = DEFAULT` reset to the server default.                                                                                                                                           | 0025 saves the caller's values and restores them.                                                                                                                                                                                                                                    |
| Minor: pre-flight printed an MD5 prefix of the value.                                                                                                                                                 | Replaced with `dense_rank()`.                                                                                                                                                                                                                                                        |
| Minor: the backfill logged success when nothing was written, and one DB error aborted the run.                                                                                                        | Fixed. A failed row is counted as `failed`, and the run continues.                                                                                                                                                                                                                   |
| Minor: the script's dependencies were undocumented.                                                                                                                                                   | Documented: python3 is needed only for `.env`, and `PSQL_CMD` is word-split.                                                                                                                                                                                                         |
