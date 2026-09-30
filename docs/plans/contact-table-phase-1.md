# Implementation plan: User & Org management refactor, Phase 1 (`contact` table)

**Date:** 2026-09-29 (rev 2, 2026-09-30, after review)
**Repo:** `aggregator-dpg`, branch `refactor/user-org-management` (cut from `feature` @ `1f31f6b`). All phases commit here.
**Status:** R0, R1 and R2 implemented on `refactor/user-org-management` (see `docs/plans/user-org-refactor-decisions.md` for every decision taken during implementation). R3 next.
**Scope:** Phase 1 of the user & org management refactor. Person-contact data (name, email, phone) moves into a dedicated `contact` table, which the coordinator and org-owner rows reference by FK.
**Design input:** Google Doc _"Blue Dots - Aggregators & User Management"_ (`1XbPjIHg…`), read on 2026-09-30. §0 below reconciles it with the code; §9 maps the doc's target model onto the later phases.

> Delete this file in the commit that ships R3 (repo convention for `docs/plans/`).

### Rev 2 changes (review findings folded in)

| Finding                                                                                                                                                                                                                                                                                                                       | Where it now lives                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Existing-instance strategy (user direction):** a pre-deploy script creates and pre-populates `contact`; the drizzle migration uses `IF NOT EXISTS` throughout and is idempotent. The migration file _is_ the script, so there is one SQL source.                                                                            | §5, §6                                              |
| B1: `BecknContact` also carries `alternatePhone`, `company` and `gstNumber` (in the API contract). Dropping the jsonb would lose them.                                                                                                                                                                                        | §3.5 `contact_extra`                                |
| B2: `SELECT DISTINCT … ON CONFLICT DO UPDATE` fails when one id appears twice. The name precedence was also inconsistent.                                                                                                                                                                                                     | §3.2, §6 backfill                                   |
| B3: strict sync triggers would change release N−1 behaviour (a 409 becomes a 503, some previously allowed writes get rejected).                                                                                                                                                                                               | §3.4, triggers are best-effort                      |
| B4: the backfill `UPDATE` would bump `updated_at` on every coordinator, which shifts the prune and cooling windows.                                                                                                                                                                                                           | §6, `set_updated_at` disabled around the backfill   |
| M1: the phone CHECK must match `normalisePhone` (`+` followed by 10–15 digits), not strict E.164.                                                                                                                                                                                                                             | §3                                                  |
| M2: there are five delete sites, and orphan contacts would block re-registration.                                                                                                                                                                                                                                             | §3.4, GC moved to DB `AFTER DELETE` triggers        |
| M3/M4: a boot-time guard would crash-loop after the script, and nothing locks against concurrent pod migrations.                                                                                                                                                                                                              | §6, first-creation-only guard plus an advisory lock |
| M5: a re-key onto an existing id, and a re-key of a shared contact.                                                                                                                                                                                                                                                           | §3.3                                                |
| User direction: the FK column is always named `contact_id`, and only a second FK in the same table takes a prefix. `aggregator_orgs.owner_contact_id` is therefore renamed to `aggregator_orgs.contact_id`.                                                                                                                   | §3 naming rule                                      |
| M6: there is no real-Postgres test harness in CI.                                                                                                                                                                                                                                                                             | §7.2                                                |
| Sub-phases 1A–1D collapse to R0 (ops) plus three releases.                                                                                                                                                                                                                                                                    | §5                                                  |
| Corrections: P5 (coordinator submit _does_ block an owner's phone, through the Keycloak attribute lookup); the root `CLAUDE.md` does not carry the "mirror" text (`schema.ts` does); the worker needs no lock-step; missed consumers (`.claude/skills/aggregator-e2e/lib/e2e-helpers.sh`, `aggregator-registrations.ts:162`). | §1, §4                                              |

---

## 0. Alignment with the design doc

### 0.1 What the doc specifies

**Organisation** is a base entity that every functional unit extends.

- Attributes: `identifier`, `name`, `primary_contact` (FK → user uuid), `org_type`, `parent_id` (FK → org).
- `org_type` is `NetworkFacilitator` or `Aggregator`, and can only be set at creation.
- There is a **single root NF org**, created at setup.
- An **Aggregator** adds `known_as`, an instance-specific enum such as Mandal, District or JFC.
- Each aggregator has exactly one parent, and the top level connects to the NF.
- There can be multiple _default_ aggregators, with selection logic when onboarding doesn't specify one.
- Instance config limits the number of immediate children and the nesting depth.
- An org can have several users (admins), one of them primary.

**Contact** is the user base object.

- Attributes: `identifier`, `name`, `email`, `phone`, `user_type` (Admin, Coordinator).
- A **Coordinator** adds `agg_for string[]`, drawn from Seeker, Provider and ServiceProvider.

**Cross-cutting concerns**

- **PII:** contact is the default PII object, and is **encrypted and masked by default**. The configuration is still a ToDo.
- **Agreements** (T&C, privacy, consent) are configurable per `user_type` / `org_type`.
- **RBAC** uses permission sets per feature, with a default mapping from user type to permission set.

**APIs**

- `/v1/org/{create, metadata/update, parent/update, user/update, read, search}`
- `/v1/user/{create, metadata/update, contact/update, read, search}`
- `contact/update` requires **OTP verification** of the email/phone.

### 0.2 How today's tables map onto the doc

| Doc concept                            | Today                                                                                | Gap                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Organisation (NF)                      | none; the NF admin is **email config only**                                          | no row                                                                                |
| Organisation (Aggregator), `parent_id` | `aggregator_orgs`, one level, behind `ORG_HIERARCHY_ENABLED`                         | no `org_type`, `known_as` or multi-level support                                      |
| Coordinator (a user)                   | `aggregators` row; **conflates the user with "their" org name** (`aggregators.name`) | P1                                                                                    |
| Coordinator `agg_for`                  | `aggregators.type` (a single text value)                                             | a scalar, not an array                                                                |
| Contact                                | `aggregators.contact` jsonb + `aggregator_orgs.owner_*` + Keycloak                   | **Phase 1**                                                                           |
| `primary_contact`                      | `aggregator_orgs.owner_email` / `owner_kc_sub`                                       | Phase 1 turns it into an FK to contact; the doc wants an FK to the **user** (Phase 2) |
| Agreements                             | `aggregator_consent_record` (polymorphic `org` / `aggregator`)                       | needs to key on `user_type` / `org_type`                                              |

### 0.3 What that means for Phase 1

- **Consistent with the doc, no change needed:**
  - The table name `contact` and the fields `name`/`email`/`phone` match.
  - Removing the duplicate columns is exactly the doc's "contact is the base object".
- **Deliberate divergences, which are forward-compatible:**
  - **`id`, not `identifier`.** This follows the repo convention: every table uses `id`.
  - **No `user_type` / `agg_for` on `contact`.** They are role and user attributes. Putting them on a hash-keyed identity row would split one person across two ids if they ever hold two roles, which is the case §10 Q1 defers. They go on the Phase 2 user record, which references `contact_id`. This matches the doc's own "Coordinator extends Contact" layering.
  - **`primary_contact` is modelled as `aggregator_orgs.contact_id` in Phase 1.** It is repointed to the user in Phase 2, when users exist.
- **PII encryption is coming, so Phase 1 must not block it:**
  - Once `email`/`phone` are encrypted, the unique indexes and lookups need **blind indexes** (deterministic keyed hashes), because they cannot index ciphertext. The plan: add `email_bidx` / `phone_bidx` columns later and move the unique constraints onto them. Nothing in Phase 1 queries plaintext except through the store, so the swap is local to `contact-store`.
  - The **unsalted `contact.id` becomes a weak point** once the plaintext is encrypted: anyone holding the id can brute-force email and phone. Because every FK is `ON UPDATE CASCADE`, the encryption phase can **re-key every id** to a keyed HMAC in one `UPDATE contact SET id = …` without touching any referencing table. Phase 1 keeps the agreed `sha256(lower(email):phone)` (§10 Q3). This escape hatch is why the cascade FKs stay even after R3.
  - **Masking:** the API responses in Phase 1 are unchanged, so no masking is added. Masking arrives with the encryption phase.
- **Contact changes without OTP.** Profile PATCH changes the phone without OTP today, and Phase 1 keeps that (no behaviour change). The doc's OTP-verified `contact/update` lands with the Phase 4 `/v1/user` APIs.

## 1. Why: the problems today

| #   | Problem                                                                                                                                                                                                                                                                                                     | Evidence                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P1  | **The table name does not match its contents.** `aggregators` stores _coordinators_. `aggregators.name` is the **organisation** name, and the person is `contact.name`.                                                                                                                                     | design-v2 spec `:54,84`; `registration.v1.json` ("Organisation Name")   |
| P2  | **The same person-contact data is stored in several shapes.** Coordinators have a `contact` jsonb plus the generated `contact_phone` / `contact_email` columns. Org owners have `owner_email` / `owner_phone` columns. Keycloak holds a third copy.                                                         | `packages/db-schema/src/schema.ts:199-205, 290-291`                     |
| P3  | **The org owner's name is not stored in the DB.** It exists only in Keycloak.                                                                                                                                                                                                                               | `routes/aggregator-orgs.ts:87-111`                                      |
| P4  | **Copies drift.** Profile PATCH mirrors only `phoneNumber` to Keycloak. `owner_email` is stored lowercased while Keycloak gets the raw value.                                                                                                                                                               | `aggregator-profile.ts:224`; `aggregator-orgs.ts:174 vs 431`            |
| P5  | **The cross-role guards are asymmetric.** Coordinator submit checks the owner's email (DB) and phone (the Keycloak `phoneNumber` attribute, `:460`). **Org create checks neither in the DB and has no phone check at all**, so an org owner can take a coordinator's phone and OTP login becomes ambiguous. | `aggregator-registrations.ts:307,353,460`; `aggregator-orgs.ts:297-350` |
| P6  | **The jsonb shape is locked by generated columns.** `contact_phone` / `contact_email` are `GENERATED ALWAYS` and carry the unique indexes. The CHECK allows `''`.                                                                                                                                           | `0005_aggregator_profile.sql:49-94`                                     |

## 2. Goal and constraints

**Goal.** Introduce a single `contact` table (`id`, `email`, `phone`, `name`) and point coordinators (`aggregators.contact_id`) and org owners (`aggregator_orgs.contact_id`) at it. Then drop `aggregators.contact` / `contact_phone` / `contact_email` and `aggregator_orgs.owner_email` / `owner_phone`.

**Hard constraints**

- **No API contract change.** `openapi.json` stays byte-identical, including `contact.{alternatePhone, company, gstNumber}`, and the OpenAPI drift check stays green.
- **Error codes are unchanged** for every flow that works today.
- **Rolling deploys are safe.** Every pod runs `runMigrations()` at boot (`server.ts:26`), so each release must work against the next release's schema, and N−1 against N's. The one destructive step (R3) is its own release.
- **Existing and fresh instances converge** on the same schema. An existing instance gets there by running the pre-deploy script first; a fresh one gets there through the normal boot migration (§5).

**Non-goals for Phase 1.** Each is moved to a later phase (§9):

- `registration_invites.email` and `aggregators.invite_email`: target addresses, with no phone and no person yet.
- `campaign_job.requested_by` and `campaign_pii_audit.*`: append-only operator audit strings.
- `owner_kc_sub`: Keycloak account identity, which belongs to Phase 2.
- Table renames.
- Keycloak re-sync (P4).
- Participant data, which lives in Signals.

## 3. Data model

```sql
contact (
  id         text PRIMARY KEY        CHECK (id ~ '^[0-9a-f]{64}$')
                                     CHECK (id = contact_id_of(email, phone)),  -- self-verifying
  email      text NOT NULL           CHECK (email = lower(btrim(email)) AND email <> ''),
  phone      text                    CHECK (phone IS NULL OR phone ~ '^\+[0-9]{10,15}$'),  -- = normalisePhone output
  name       text                    CHECK (name IS NULL OR btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()          -- set_updated_at() trigger
)
UNIQUE (email);  UNIQUE (phone) WHERE phone IS NOT NULL   -- phone: §10 Q1 = yes
aggregators.contact_id           text FK → contact(id) ON DELETE RESTRICT ON UPDATE CASCADE
aggregators.contact_extra        jsonb NOT NULL DEFAULT '{}'   -- §3.5
aggregator_orgs.contact_id text FK → contact(id) ON DELETE RESTRICT ON UPDATE CASCADE
```

**FK naming rule (decided 2026-09-30).**

- Every FK to `contact` is named **`contact_id`**, so it is `aggregators.contact_id` and `aggregator_orgs.contact_id`. It is not `owner_contact_id`.
- If a table ever needs a **second** contact FK, only the second one takes a role prefix, e.g. `invitee_contact_id` or `approver_contact_id`. The first one stays `contact_id`.
- Constraint and index names follow the pattern `<table>_contact_id_fk` / `<table>_contact_id_idx`, and in Drizzle the field is `contactId`.
- Phase 1 has one contact FK per table, so no prefixes are needed. The rule carries into later phases (§9).
- In SQL that joins both tables, always qualify the column (`a.contact_id`, `o.contact_id`).

### 3.1 The id: a one-way hash

```
id = sha256_hex( lower(btrim(email)) || ':' || coalesce(phone, '') )
```

- **Inputs are canonical before they are stored.**
  - The email goes through the existing `normaliseEmail`.
  - The phone goes through the existing `normalisePhone` (`shared-primitives/src/phone`): a bare 10-digit number becomes `+91…`, and the output is `+` followed by 10–15 digits.
  - SQL never normalises. It hashes the stored canonical values, and pre-flight asserts they really are canonical.
- **If there is no phone, hash with an empty phone** (`email:`). Owner phone is nullable today.
- **One formula, tested from both sides.**
  - In TS: `contactId()` in the new `@aggregator-dpg/shared-primitives/contact` subpath, alongside `ContactSchema` and the `Contact` type.
  - In SQL: the `IMMUTABLE` function `contact_id_of()`, which the CHECK constraint also uses.
  - Golden vectors cover ASCII, **non-ASCII** and a NULL phone. JS `toLowerCase` and PG `lower` differ outside ASCII, so pre-flight counts non-ASCII emails.
- **Why a hash:** looking up or creating a contact is one deterministic `INSERT … ON CONFLICT DO NOTHING` with no read first.
- **Treat `contact.id` as PII.** An unsalted hash of email+phone can be brute-forced. The logging rule forbids PII-derived identifiers, so the id is never logged, never sent to telemetry and never put in a URL. Log the row ids (`aggregator_id`, `org_id`) instead.

### 3.2 Which name wins

- **Insert paths** (registration, org create, backfill, the legacy insert trigger): the **existing name wins**. The update is `coalesce(contact.name, new_name)`. In the backfill the coordinator's name beats the owner's (NULL).
- **Explicit update paths** (profile PATCH, the legacy `UPDATE OF contact` trigger): the **new name wins**.
- The wire `contact.name` is a required string, so it is composed as `coalesce(name, '')`, and pre-flight counts empty names.

### 3.3 Changing email or phone (a re-key)

The FKs are `ON UPDATE CASCADE`. There are three cases for a change of email or phone:

| Case                                                                                  | Action                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The target id already exists (the person already has that contact)                    | **Repoint**: set the FK to the existing row, then GC the old one.                                                                                                                                                                                                                                             |
| The old contact is referenced **only by this row**                                    | **Re-key** in place: `UPDATE contact SET id, email, phone WHERE id = old`. The cascade moves the FK.                                                                                                                                                                                                          |
| The old contact is **shared** (one person holds a coordinator role and an owner role) | The app **refuses** with `CONFLICT` in Phase 1, because otherwise the other role's email/phone would change silently while Keycloak does not follow. The legacy trigger in that case leaves the FK NULL and logs a WARNING. This case is blocked today by `OWNER_ALREADY_REGISTERED`, so it should not occur. |

- If a re-key hits `contact_email_unique` or `contact_phone_unique`, the app returns `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`, the same codes as today.
- A name-only change is `UPDATE contact SET name`.
- The re-key in the triggers runs in an **AFTER** trigger. Running it in a BEFORE trigger would make the cascade modify the row being updated, which fails with "tuple already modified".

### 3.4 Sync and GC live in the database, and are best-effort

- **Triggers keep `contact` in step with legacy writes.** Release N−1, and N−1 writes that land between the pre-deploy script and the rollout, write only the old columns. The triggers keep `contact` in step with them. They **never fail a legacy write**:
  - an untargeted `ON CONFLICT DO NOTHING`
  - a name that is empty or whitespace becomes NULL
  - an invalid phone skips linking
  - an unresolved conflict leaves the FK NULL and raises a `WARNING`
- **Legacy error contracts are preserved.** Coordinator-vs-coordinator duplicates are still caught first by the legacy `aggregators_contact_{email,phone}_unique` indexes, with exactly the same error codes. The _new_ cross-role invariants are enforced by R1 app pre-checks, which return proper codes (§4.5).
- **Orphan GC runs in the DB, not the app.** An `AFTER DELETE` trigger on both tables (and the same logic after a repoint) deletes a contact that nothing references any more. It is guarded with `EXCEPTION WHEN foreign_key_violation`. This covers all five delete sites, including N−1's:
  - prune coordinators: `aggregator-maintenance.ts:187`
  - prune orgs: `aggregator-maintenance.ts:220`
  - consent rollback: `aggregator-registrations.ts:501,534`
  - org consent rollback: `aggregator-orgs.ts:406`
- **Gate:** V1 (the count of NULL FKs) must be 0 before R2/R3.

### 3.5 `contact_extra` preserves the optional Beckn fields

- **The problem.** `BecknContactSchema` (`shared-primitives/src/beckn/index.ts:35-48`) also accepts optional `alternatePhone`, `company` and `gstNumber`. They appear in `openapi.json` on registration create and on profile GET/PATCH, and registration stores them through `...body.contact` (`aggregator-registrations.ts:235`). They are not identity, so they don't belong in `contact`.
- **The fix.** They move to `aggregators.contact_extra jsonb`.
  - The backfill sets it to `contact - 'name' - 'phone' - 'email'`.
  - The insert/update triggers maintain it.
  - The wire `contact` is composed as `{...contact_extra, name, phone, email}`.
- Pre-flight reports how many rows carry extras.

### 3.6 Uniqueness summary

| Invariant                        | Today                                                                       | After Phase 1                                                     |
| -------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Coordinator email / phone unique | `aggregators_contact_{email,phone}_unique`                                  | `contact_{email,phone}_unique` (the legacy indexes stay until R3) |
| Email unique across both roles   | effectively yes (Keycloak username = email, `duplicateEmailsAllowed:false`) | yes, in the DB too. **No behaviour change.**                      |
| Phone unique across both roles   | coordinator→owner yes (Keycloak attribute check); **owner→coordinator no**  | yes. **Tightening at org create only** (§10 Q1)                   |

## 4. Code changes, by package

### 4.1 `packages/shared-primitives` and `packages/db-schema`

- **Add `shared-primitives/src/contact/index.ts`** containing:
  - `ContactSchema`
  - `contactId(email, phone)`, which reuses `normaliseEmail` and `normalisePhone`
  - golden-vector tests
  - a subpath export
- **`BecknContact` is unchanged.** It stays the wire shape.
- **`db-schema/schema.ts`:**
  - add the `contact` table, `aggregators.contactId` / `contactExtra` and `aggregatorOrgs.contactId`
  - add `ContactRow` / `NewContactRow`
  - fix the header comment at `:17` and `:197-198`, which calls the jsonb the Keycloak mirror
  - in R2, remove the legacy columns from the drizzle table definitions
- **Update the tests** `schema.columns.test.ts` and `schema.indexes-and-relations.test.ts`.
- **Migrations are hand-written, and so is the journal entry.** Snapshots exist only for 0000–0003, 0019, 0020 and 0022, so `drizzle-kit generate` would diff against a stale base.

### 4.2 `apps/api`: `services/contact-store/`

- **Layout:** `interface.ts` (abstract `ContactStoreBase`), `postgres.ts`, `memory.ts` and `testing.ts` (`buildContact()`, `seed()`). Every method returns `Result<T, BaseError>`.
- **Methods:**
  - `link(input, tx)`: insert-or-get following the §3.2 name rule.
  - `findByEmail` / `findByPhone` / `findById`
  - `change(id, patch, tx)`: follows §3.3 (repoint, re-key, or refuse when shared).
- **Errors:** `contact_email_unique` maps to `DUPLICATE_EMAIL` and `contact_phone_unique` to `DUPLICATE_PHONE`.
- **No `deleteIfOrphan`:** GC is done by the DB triggers (§3.4).

### 4.3 `apps/api`: aggregator store (coordinators)

- **`create` / `update` write contact first.** The order is `contactStore.link`/`change`, then the row, with `contact_id` and `contact_extra` set. In R1 the store **also** still writes the legacy `contact` jsonb (dual-write), and the triggers then compute the same id, so it is a no-op.
- **`findByContactEmail` / `findByContactPhone` read through the join.** The signatures are unchanged.
- **The row mapper builds the `Aggregator` record's `contact` from the join plus `contact_extra`,** and it **keeps `contactPhone` / `contactEmail` as derived fields**. Because of that, `aggregator-registrations.ts:162` and `campaign/submit-job.ts:226` need no edit.
  - **R1 only:** when `contact_id IS NULL` (a straggler from a conflict), fall back to the legacy jsonb.
- **`memory.ts` delegates to the memory contact store,** which replaces its private `byPhone` / `byEmail` maps.

### 4.4 `apps/api`: org store (owners)

- **`create`** links a contact from `owner.{email, phone, name}`. This persists the owner's name and fixes P3.
- **`findByOwnerEmail` reads through the join.** The record keeps `ownerEmail` / `ownerPhone` as derived fields, so the approvals, invites, resend rate-limit and notify code need no change.
- **`mapInsertError` (`aggregator-org-store/postgres.ts:170-179`)** today turns every unknown unique violation into `DB_UNAVAILABLE`. It gains two mappings:
  - `contact_email_unique` → `OWNER_ALREADY_REGISTERED`
  - `contact_phone_unique` → `PHONE_EXISTS`
- **`update({ownerPhone})`** calls `contactStore.change()`.

### 4.5 `apps/api`: routes

| Route                         | Change                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregator-orgs.ts`          | Pass `owner.name` through. Before the insert, **pre-check** the owner's email and phone against `contact`. This returns today's `OWNER_ALREADY_REGISTERED` for the email, and the new `PHONE_EXISTS` for the phone (§10 Q1 = yes). The **email** result stays identical to today's Keycloak-driven 409, and the check now runs before any row is written. |
| `aggregator-registrations.ts` | No flow change. The existing DB and Keycloak checks stay, and the lookups go through the stores.                                                                                                                                                                                                                                                          |
| `aggregator-profile.ts`       | PATCH goes through `store.update` → `contactStore.change`. The response shape is unchanged. The shared-contact refusal returns `CONFLICT`, which already exists (`:350`).                                                                                                                                                                                 |
| `aggregator-maintenance.ts`   | No change, because the DB handles GC.                                                                                                                                                                                                                                                                                                                     |

### 4.6 `apps/worker`

- **No code change and no lock-step deploy.** The worker selects explicit columns only (`link-metrics-rollup.ts:54`, `bulk-finalise.ts:54`, `bulk-row-process.ts:375`), and drizzle lists the schema's columns explicitly. The image is rebuilt only because `db-schema` changes.

### 4.7 `apps/web`

- **No functional change,** because the contract is unchanged.
- **The hand-copied `BecknContact` type in `services/profile.service.ts:10-17` stays.** It correctly includes the extra fields, so importing the shared type would bring nothing. Only a comment is added pointing at the canonical schema.
- **The `profile.service` and `ProfileFormView` tests must pass unchanged.** That is the check that the contract held.
- **RJSF schemas are unchanged.**

### 4.8 Other consumers

- **`.claude/skills/aggregator-e2e/lib/e2e-helpers.sh:246,295-298`** inserts orgs with a raw `owner_email` and deletes by `contact_email`. Update it in R2 so it goes through the API or `contact`.
- **About 25 tests** reference `contactEmail` / `ownerEmail` (see `grep`). They are updated with their store.
- **`docs/aggregator-profile-table-review.md`** has stale line references. Add a note in R3.

## 5. Rollout: one ops step, then three releases

Each release is one commit group on `refactor/user-org-management`. Before a release goes out, the checks in §7 must pass on **every** instance.

| Step                                | Existing instance                                                                                                                                                                                   | Fresh instance                                                  | Code                                                                                                                                                                                                                                                                | Migration                                                     | Roll back to                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **R0: pre-deploy script** (ops)     | `scripts/contact-migrate.sh preflight → dry-run → apply → verify` creates and pre-populates `contact` and installs the sync triggers. It runs against the **live** DB while release N−1 is serving. | not needed                                                      | none                                                                                                                                                                                                                                                                | runs `0025_contact.sql` directly                              | nothing to roll back: the change is additive and N−1 ignores it (the triggers are best-effort) |
| **R1: app owns contact**            | boot re-runs 0025 as a no-op (it relinks any N−1 stragglers) and records it in `__drizzle_migrations`                                                                                               | boot runs 0025, which creates everything; the backfill is empty | **reads** come through the `contact` join (legacy fallback for unlinked rows); **writes stay on the legacy columns** and the DB triggers maintain `contact` (decisions log D5); org-create pre-checks and owner name (D7/D8); the `postgres:16` CI service (§10 Q5) | `0025_contact.sql` (journal idx 25)                           | N−1 (the legacy columns are still dual-written)                                                |
| **R2: stop the legacy writes**      | —                                                                                                                                                                                                   | —                                                               | the app writes `contact` directly (new `ContactStore`: link / change, §3.3) and stops writing the legacy columns; the e2e helper is updated                                                                                                                         | **none**, because 0025 already relaxed the legacy `NOT NULL`s | R1 (R1 reads through the join)                                                                 |
| **R3: contract** (**irreversible**) | take a DB snapshot first                                                                                                                                                                            | —                                                               | delete this plan; update the docs                                                                                                                                                                                                                                   | `0026_contact_drop_legacy.sql`                                | restore from the snapshot only                                                                 |

**Rollback limits**

- **R2 → N−1 is not allowed.** N−1 reads the legacy jsonb, which R2 leaves NULL on new rows. This goes in the R2 release notes.
- **Do not merge R2 and R3.** R1 pods still dual-write the legacy columns during the R2 rollout, so R3's drops must wait until R2 is on every pod.

**Why R0 exists even though R1's boot would do the same work:**

- the table is created and backfilled off the deploy path, with pre-flight run by a human
- conflicts are found and fixed **before** any new code runs
- the boot-time migration becomes a fast no-op, so there is no long lock during pod start

## 6. Pre-deploy script and idempotent migration

### 6.1 One SQL source

**`apps/api/drizzle/migrations/0025_contact.sql` _is_ the script.**

- The ops wrapper runs that exact file with `psql`, and drizzle re-runs it at boot. There is no second copy that could drift.
- Drizzle's pg migrator (`drizzle-orm@0.45.2`, `pg-core/dialect.js:44-72`):
  - runs all pending files in one transaction
  - skips a file by the journal `when` high-water mark
  - records the file hash but never compares it
  - takes no lock
- **Constraints on the file:**
  - no `BEGIN`/`COMMIT`, no psql `\` meta-commands, no bind parameters
  - `--> statement-breakpoint` is an ordinary SQL comment to `psql`
- **Every object is idempotent:**

| Object                                                 | Pattern                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| table                                                  | `CREATE TABLE IF NOT EXISTS`                             |
| column                                                 | `ADD COLUMN IF NOT EXISTS`                               |
| index                                                  | `CREATE [UNIQUE] INDEX IF NOT EXISTS`                    |
| FK / CHECK (Postgres has no `IF NOT EXISTS` for these) | a `DO $$` block that tests `pg_constraint` first         |
| function                                               | `CREATE OR REPLACE FUNCTION`                             |
| trigger                                                | `CREATE OR REPLACE TRIGGER` (PG14+)                      |
| `DROP NOT NULL`                                        | idempotent by nature                                     |
| backfill                                               | `WHERE contact_id IS NULL` plus `ON CONFLICT DO NOTHING` |

- **Version marker.** `COMMENT ON TABLE contact IS 'contact-schema:v1'`. The migration **refuses** to silently no-op over a `contact` table that carries a different marker. This protects against a table left behind by an older draft of the script.
- **Concurrency.** The first statement is `SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0025_contact'))`, with `SET LOCAL lock_timeout='5s'` and `statement_timeout='300s'`. Concurrent pod boots (HPA) and the ops script serialise on it, and idempotency makes the second runner a no-op.
- **Pre-flight guard.** The guard is fatal **only on first creation** (`to_regclass('public.contact') IS NULL`). On any later re-run it only raises a `WARNING` with counts, so a boot after R0 never crash-loops over conflicts written by N−1 in the meantime.
- **Journal entry:** `{"idx":25,"version":"7","when":<greater than 1790695000000 and greater than any in-flight branch>,"tag":"0025_contact","breakpoints":true}`.

### 6.2 Files

| File                                           | Purpose                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/drizzle/migrations/0025_contact.sql` | idempotent DDL, the backfill, the sync and GC triggers, and relaxing the legacy `NOT NULL`s                                                                                                                                                             |
| `scripts/contact-migrate.sh`                   | ops wrapper modelled on `scripts/backfill-kc-aggregator-type.sh`; takes `DATABASE_URL` or `PG_CONTAINER`, and on k8s pipes through `kubectl exec -i <psql pod> -- psql`                                                                                 |
| `scripts/sql/contact-preflight.sql`            | read-only report; outputs **row ids and counts only, never PII**                                                                                                                                                                                        |
| `scripts/sql/contact-verify.sql`               | checks V1–V6 (§7.1)                                                                                                                                                                                                                                     |
| `scripts/backfill-owner-contact-names.ts`      | fills `contact.name` for owners from the Keycloak `firstName`/`lastName` via `owner_kc_sub`; supports `--dry-run`, is idempotent, and applies timeout, retry and structured logs; **run from a checkout** (the api image has no tsx); run once after R1 |

**Modes of `contact-migrate.sh`.** All modes use `psql -X -v ON_ERROR_STOP=1`. Run it from a checkout of the **release tag**. It prints the file's `sha256sum` and never writes `__drizzle_migrations`; drizzle records the migration at the R1 boot.

| Mode        | Command                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `preflight` | `-f scripts/sql/contact-preflight.sql`                                       |
| `dry-run`   | `-c BEGIN -f 0025_contact.sql -f scripts/sql/contact-verify.sql -c ROLLBACK` |
| `apply`     | `--single-transaction -f 0025_contact.sql`                                   |
| `verify`    | `-f scripts/sql/contact-verify.sql`                                          |

### 6.3 Runbook for an existing instance

1. **`preflight`.** Every count must be 0. Fix rows by hand, record by record, and coordinate with Keycloak. The likely email collisions are leftover `inactive` org rows with `owner_kc_sub IS NULL`, created when Keycloak `USER_EXISTS` fired after the insert (`aggregator-orgs.ts:441`); pre-flight lists them separately as safe to delete.
2. **`dry-run`.**
3. **`apply`.** Run it off-peak: it takes brief exclusive locks on `aggregators` and `aggregator_orgs`. If `lock_timeout` fires, retry.
4. **`verify`.** V1–V4 must all be 0.
5. **Deploy R1.**
6. **`verify` again.** Then run the owner-name backfill, and check V5.

### 6.4 Pre-flight checks

Each check reports ids and counts only; every count must be 0 except the informational ones.

- **Emails with more than one distinct phone** across `aggregators` ∪ `aggregator_orgs`. These would violate `contact_email_unique`.
- **Phones held by more than one email** across both tables (§10 Q1 = yes).
- **Phones not matching `^\+[0-9]{10,15}$`.**
- **Emails that are empty, not lowercase/trimmed, or non-ASCII.**
- **Empty or whitespace names** (informational: they become NULL).
- **Rows carrying `alternatePhone`, `company` or `gstNumber`** (informational: they move to `contact_extra`).
- **Leftover orgs with `status='inactive'` and `owner_kc_sub IS NULL`** (listed separately).

### 6.5 SQL skeleton (`0025_contact.sql`)

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';
SELECT pg_advisory_xact_lock(hashtext('aggregator-dpg:0025_contact'));

-- Version marker: never no-op over a foreign contact table
DO $$ BEGIN
  IF to_regclass('public.contact') IS NOT NULL
     AND coalesce(obj_description('public.contact'::regclass,'pg_class'),'') <> 'contact-schema:v1' THEN
    RAISE EXCEPTION '0025: contact table exists with unexpected version marker';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION contact_id_of(p_email text, p_phone text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT encode(sha256(convert_to(lower(btrim(p_email)) || ':' || coalesce(p_phone,''),'UTF8')),'hex') $$;

-- Pre-flight guard: fatal only on FIRST creation
DO $$ DECLARE n_email int; n_phone int; n_fmt int; BEGIN
  IF to_regclass('public.contact') IS NULL THEN
    WITH src AS (
      SELECT lower(btrim(contact->>'email')) e, contact->>'phone' p FROM aggregators
      UNION ALL SELECT lower(btrim(owner_email)), owner_phone FROM aggregator_orgs)
    SELECT (SELECT count(*) FROM (SELECT e FROM src GROUP BY e HAVING count(DISTINCT coalesce(p,''))>1) a),
           (SELECT count(*) FROM (SELECT p FROM src WHERE p IS NOT NULL GROUP BY p HAVING count(DISTINCT e)>1) b),
           (SELECT count(*) FROM src WHERE (p IS NOT NULL AND p !~ '^\+[0-9]{10,15}$') OR coalesce(e,'')='')
      INTO n_email, n_phone, n_fmt;
    IF n_email + n_phone + n_fmt > 0 THEN
      RAISE EXCEPTION '0025 preflight failed: email=% phone=% format=% (run scripts/contact-migrate.sh preflight)',
        n_email, n_phone, n_fmt;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contact (
  id    text PRIMARY KEY CONSTRAINT contact_id_hex_chk CHECK (id ~ '^[0-9a-f]{64}$'),
  email text NOT NULL CONSTRAINT contact_email_chk CHECK (email = lower(btrim(email)) AND email <> ''),
  phone text CONSTRAINT contact_phone_chk CHECK (phone IS NULL OR phone ~ '^\+[0-9]{10,15}$'),
  name  text CONSTRAINT contact_name_chk  CHECK (name IS NULL OR btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_id_matches_chk CHECK (id = contact_id_of(email, phone))
);
COMMENT ON TABLE contact IS 'contact-schema:v1';
CREATE UNIQUE INDEX IF NOT EXISTS contact_email_unique ON contact (email);
CREATE UNIQUE INDEX IF NOT EXISTS contact_phone_unique ON contact (phone) WHERE phone IS NOT NULL; -- §10 Q1
CREATE OR REPLACE TRIGGER contact_set_updated_at BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE aggregators     ADD COLUMN IF NOT EXISTS contact_id text;
ALTER TABLE aggregators     ADD COLUMN IF NOT EXISTS contact_extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE aggregator_orgs ADD COLUMN IF NOT EXISTS contact_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aggregators_contact_id_fk'
                 AND conrelid = 'public.aggregators'::regclass) THEN
    ALTER TABLE aggregators ADD CONSTRAINT aggregators_contact_id_fk FOREIGN KEY (contact_id)
      REFERENCES contact(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'aggregator_orgs_contact_id_fk'
                 AND conrelid = 'public.aggregator_orgs'::regclass) THEN
    ALTER TABLE aggregator_orgs ADD CONSTRAINT aggregator_orgs_contact_id_fk FOREIGN KEY (contact_id)
      REFERENCES contact(id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS aggregators_contact_id_idx           ON aggregators (contact_id);
CREATE INDEX IF NOT EXISTS aggregator_orgs_contact_id_idx ON aggregator_orgs (contact_id);

-- Relax legacy NOT NULLs now (harmless to N-1, which always writes them; makes R2 migration-free)
ALTER TABLE aggregators ALTER COLUMN contact DROP NOT NULL,
  ALTER COLUMN contact_phone DROP NOT NULL, ALTER COLUMN contact_email DROP NOT NULL;
ALTER TABLE aggregator_orgs ALTER COLUMN owner_email DROP NOT NULL;

-- Sync + GC (CREATE OR REPLACE FUNCTION / TRIGGER); ALL best-effort, never fail a legacy write:
--   contact_link(email, phone, name) -> text
--       skip an invalid phone; INSERT ... ON CONFLICT DO NOTHING (untargeted);
--       UPDATE contact SET name = coalesce(name, NULLIF(btrim(name_in), '')) WHERE id = v;
--       RETURN v if a row with that id exists, else RAISE WARNING and RETURN NULL
--   contact_gc(id)
--       DELETE the contact when no row in either table references it;
--       EXCEPTION WHEN foreign_key_violation THEN NULL
--   aggregators BEFORE INSERT
--       NEW.contact_id := contact_link(...);
--       NEW.contact_extra := coalesce(NEW.contact, '{}') - 'name' - 'phone' - 'email'
--   aggregators BEFORE UPDATE OF contact
--       maintain NEW.contact_extra only
--   aggregators AFTER UPDATE OF contact WHEN (OLD.contact IS DISTINCT FROM NEW.contact)
--       NEW.contact NULL                  -> return
--       same id                           -> name sync (the new name wins)
--       target id exists                  -> repoint, then contact_gc(old)
--       old contact shared by other rows  -> SET contact_id NULL + WARNING
--       otherwise                         -> re-key (UPDATE contact SET id/email/phone);
--                                            EXCEPTION WHEN unique_violation -> SET contact_id NULL + WARNING
--   aggregators AFTER DELETE
--       contact_gc(OLD.contact_id)
--   aggregator_orgs: the same set over owner_email / owner_phone
--       (AFTER UPDATE OF owner_email, owner_phone)

-- Backfill: set-based, tolerant, and does NOT bump updated_at (prune/cooling windows depend on it)
ALTER TABLE aggregators DISABLE TRIGGER aggregators_set_updated_at;
INSERT INTO contact (id, email, phone, name)
SELECT DISTINCT ON (id) id, e, p, n FROM (
  SELECT contact_id_of(contact->>'email', contact->>'phone') id, lower(btrim(contact->>'email')) e,
         contact->>'phone' p, NULLIF(btrim(contact->>'name'), '') n, 0 prio
    FROM aggregators WHERE contact_id IS NULL AND contact IS NOT NULL
  UNION ALL
  SELECT contact_id_of(owner_email, owner_phone), lower(btrim(owner_email)), owner_phone, NULL, 1
    FROM aggregator_orgs WHERE contact_id IS NULL AND owner_email IS NOT NULL
) s ORDER BY id, prio, n NULLS LAST
ON CONFLICT DO NOTHING;
UPDATE aggregators a SET contact_id = c.id, contact_extra = a.contact - 'name' - 'phone' - 'email'
  FROM contact c
 WHERE a.contact_id IS NULL AND a.contact IS NOT NULL
   AND c.id = contact_id_of(a.contact->>'email', a.contact->>'phone');
UPDATE aggregator_orgs o SET contact_id = c.id
  FROM contact c
 WHERE o.contact_id IS NULL AND o.owner_email IS NOT NULL
   AND c.id = contact_id_of(o.owner_email, o.owner_phone);
ALTER TABLE aggregators ENABLE TRIGGER aggregators_set_updated_at;
-- (aggregator_orgs has no set_updated_at trigger: only 0005 defines triggers, all on aggregators)

DO $$ DECLARE n int; BEGIN
  SELECT (SELECT count(*) FROM aggregators     WHERE contact_id IS NULL       AND contact IS NOT NULL)
       + (SELECT count(*) FROM aggregator_orgs WHERE contact_id IS NULL AND owner_email IS NOT NULL)
    INTO n;
  IF n > 0 THEN RAISE WARNING '0025: % rows unlinked (conflicts); see contact-verify.sql V1', n; END IF;
END $$;
```

**How the backfill avoids the B2 failure:** it uses `DISTINCT ON (id)`, so one id is never inserted twice in a single statement, which would otherwise raise "cannot affect row a second time". The coordinator row wins over the owner row, and a non-NULL name wins over NULL.

### 6.6 R3: `0026_contact_drop_legacy.sql`

Also idempotent: `DROP … IF EXISTS` throughout, and no `CASCADE`, so an unexpected dependent fails the migration loudly, as 0023 does. It:

1. drops the sync triggers and `contact_link`
2. drops the legacy unique indexes `aggregators_contact_{phone,email}_unique` and `aggregator_orgs_owner_email_idx`
3. drops `aggregators_contact_shape_chk`
4. drops the columns `contact_phone`, `contact_email`, `contact`, `owner_email` and `owner_phone`
5. sets `aggregators.contact_id` and `aggregator_orgs.contact_id` to `NOT NULL`

- **GC.** It keeps `contact_gc` and the `AFTER DELETE` triggers; they stay as the permanent GC path.
- **Rolling deploy.** Rolling deploys are safe, because R2 code never touches the dropped objects. The file header states this, following the 0023 precedent.

## 7. Verification

### 7.1 SQL checks (`scripts/sql/contact-verify.sql`, read-only)

| Id  | Check                                                                                                                                                                                      | Expect                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| V1  | Rows with no FK: `aggregators` where `contact_id IS NULL AND contact IS NOT NULL`, plus the same for orgs                                                                                  | 0. Gates R2 and R3.                                              |
| V2  | `contact.id <> contact_id_of(email, phone)`                                                                                                                                                | 0 (the CHECK enforces it too)                                    |
| V3  | Orphan contacts, referenced by neither table                                                                                                                                               | 0                                                                |
| V4  | (R0–R1) Drift: legacy `contact->>'email'/'phone'/'name'` or `owner_email`/`owner_phone` differs from the joined contact, or `contact_extra` differs from the jsonb minus the identity keys | 0                                                                |
| V5  | Org contacts with `name IS NULL` after the owner-name backfill                                                                                                                             | 0, or only orgs whose Keycloak user is gone (these are reported) |
| V6  | (R2 and later) Rows written by R2 have `contact IS NULL` and a non-NULL `contact_id`                                                                                                       | as expected                                                      |

### 7.2 Tests

- **Per commit:** `pnpm -w typecheck lint test`, `pnpm dep-check`, and the OpenAPI drift check (**the contract must be unchanged**).
- **Unit tests:**
  - contact-store conformance against memory and postgres (link, the name rule, re-key, repoint, refusal when shared, duplicate mapping)
  - aggregator-store and org-store join tests, including `contact_extra` composition and the R1 legacy fallback
  - the new `mapInsertError` mappings in the org store
  - `contactId()` golden vectors
- **Integration tests** (real Postgres; `*.integration.test.ts` gated on `INTEGRATION_DATABASE_URL`, following the precedent in `campaign-job-store/__tests__/postgres.integration.test.ts`):
  - a fresh DB goes through the full migrator; all objects exist and the tables are empty
  - applying 0025 via `psql` **twice** and then running the full migrator raises no error, `__drizzle_migrations` gains exactly one 0025 row, and `pg_get_triggerdef` / `pg_get_constraintdef` are unchanged
  - two concurrent migrators: one waits on the advisory lock, and both succeed
  - legacy (N−1-shaped) insert, update and delete produce the expected contact, re-key, repoint and GC
  - a cross-role conflict leaves the FK NULL while the legacy write still succeeds
  - coordinator duplicates still map to `DUPLICATE_EMAIL` / `DUPLICATE_PHONE`
  - the backfill leaves `updated_at` untouched
  - the SQL `contact_id_of()` matches the TS `contactId()` on the golden vectors, including non-ASCII input and a NULL phone
- **CI.** R1 adds a `postgres:16` service to `ci.yml`, so these integration tests run on every PR (§10 Q5).
- **Manual smoke test on the local stack.** Run it with the flag off **and** with `ORG_HIERARCHY_ENABLED=true`, first on a **fresh** stack, then on a stack **seeded with pre-change data** that has had R0 applied:
  1. A coordinator registers.
  2. A duplicate email or phone is rejected with the same error as today.
  3. The approval works, and OTP login works.
  4. The profile GET JSON is byte-identical to a capture taken from the pre-change build, including `contact_extra` fields.
  5. A profile PATCH changes the phone (a re-key).
  6. An org registers and is approved; the owner invites a coordinator, who registers under the org.
  7. The prune endpoint deletes a stale registration, and its contact is GC'd.
  8. A campaign export works, and `requested_by` is unchanged.

## 8. Risks

| Risk                                              | Mitigation                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A dirty instance blocks the unique indexes        | R0 pre-flight is a hard gate, fixed by hand, and the guard is fatal on first creation only. Because the whole migration is one transaction, nothing is half-applied. |
| The boot migration crash-loops after R0           | The guard only warns on a re-run. The advisory lock and idempotency make a re-run safe.                                                                              |
| The TS and SQL hashes diverge                     | Canonical inputs are stored and SQL never normalises. Golden vectors, the `contact_id_matches_chk` CHECK, and V2.                                                    |
| N−1 behaviour changes after R0                    | The triggers are best-effort and never fail a legacy write. The legacy unique indexes keep today's error codes.                                                      |
| Orphan contacts block re-registration             | DB `AFTER DELETE` GC triggers cover all five delete sites, including N−1's. V3.                                                                                      |
| The backfill shifts the prune and cooling windows | `set_updated_at` is disabled around the backfill, and a test covers it.                                                                                              |
| Contract fields are lost                          | `contact_extra`, plus the byte-identical profile JSON smoke check.                                                                                                   |
| Rolling back past R2 to N−1                       | Documented. R2 is code-only and can roll back to R1.                                                                                                                 |
| R0 locks tables on a live DB                      | Run it off-peak, with `lock_timeout` 5s and a retry. The backfill is set-based and the tables are small (one row per coordinator or org).                            |
| A shared contact is re-keyed silently             | Phase 1 refuses it (`CONFLICT`). The case is unreachable today.                                                                                                      |
| Keycloak still keeps its own copy (P4)            | Out of scope on purpose; Phase 2.                                                                                                                                    |
| `contact.id` is treated as anonymous              | It is treated as PII: never logged, never in telemetry or URLs. Phase 5 re-keys it to a keyed HMAC through the cascade FKs (§0.3).                                   |

## 9. Later phases (mapped to the design doc)

Each phase follows the same R0→R3 rhythm: an idempotent migration that doubles as the pre-deploy script, then expand, switch and contract releases. The API contract stays stable until Phase 4 introduces the new endpoints alongside the old ones. Every FK to `contact` follows the §3 naming rule.

| Phase                | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Doc reference                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **1** (this plan)    | The `contact` table; FKs from coordinators and org owners; the duplicate columns dropped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Contact                                                               |
| **2: users**         | A `user` table (uuid `id`, `contact_id`, `user_type` Admin/Coordinator, `agg_for text[]` backfilled from `aggregators.type`, Keycloak `sub`, status). It absorbs `owner_kc_sub`, the `aggregator_id` Keycloak-attribute binding and the non-audit `created_by`/`updated_by`. A single Keycloak sync point fixes P4. **Coordinator-who-is-also-an-org-contact** (the §10 Q1 carve-out) is solved here, with one contact and two user roles or memberships.                                                                                                                                                                                                         | Contact.user_type, Coordinator.agg_for, `primary_contact` → user uuid |
| **3: organisation**  | An `organisation` table (`org_type` NF/Aggregator, immutable after creation; `parent_id`; `known_as` from an instance enum in config; `primary_contact` → user; an extensible `profile` jsonb plus a schema ref). Seed the **root NF org** at setup (from today's NF email config). Migrate `aggregator_orgs` rows to Aggregator orgs, and move the coordinator's "organisation name" (`aggregators.name`) onto an org row. Add org↔user membership (many admins, one primary). Add instance-config limits (max children, max depth) and default aggregators with a selection rule. `aggregators` / `aggregator_orgs` become compatibility views for one release. | Organisation, Aggregator.known_as, multi-level, defaults              |
| **4: APIs**          | Add `/v1/org/*` and `/v1/user/*` per the doc, including OTP-verified `user/contact/update`. Deprecate the old registration/profile routes behind them; the web moves over screen by screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | APIs                                                                  |
| **5: cross-cutting** | PII encryption and masking of `contact` (blind indexes, and re-keying `contact.id` to a keyed HMAC through the cascade FKs, §0.3). Agreements keyed on `user_type`/`org_type` (evolving `aggregator_consent_record`). RBAC permission sets.                                                                                                                                                                                                                                                                                                                                                                                                                       | Encryption on PII, Agreements, RBAC                                   |

The doc's "ToDo, don't consider" items (users under 18, the profile lifecycle, actions) are out of scope for every phase until the doc defines them.

## 10. Decisions (all answered 2026-09-30)

1. **Global phone uniqueness: YES.** `contact_phone_unique` ships. At org create, an owner who reuses a coordinator's phone gets `PHONE_EXISTS`, and pre-flight checks for phone collisions. The case of one person being both a coordinator and an org owner ("coordinator using the org contact") will be **handled separately** in a later phase (§9 Phase 2). Until then it stays blocked, as it is today (`OWNER_ALREADY_REGISTERED`, plus the shared-contact re-key refusal in §3.3).
2. **Design doc: read on 2026-09-30,** via Chrome DevTools (`mobilebasic` view). It is reconciled in §0, and the later phases are mapped in §9. It changes nothing in Phase 1's scope, but it adds the PII-encryption forward-compatibility constraints (§0.3).
3. **Hash input: YES.** Exactly `lower(email):phone`, with the phone in `normalisePhone` form and `''` when absent. Pinned by the golden vectors.
4. **Out-of-scope bugs: filed as separate issues.**
   - #822: the admin review email shows the org name as the "Contact".
   - #823: the sidebar org card shows the user's email, plus a hardcoded `'TRRAIN'` fallback.
   - #824: `aggregators.profile` / `aggregator_orgs.profile` are write-only.
5. **CI Postgres: YES.** R1 adds a `postgres:16` service to the `ci` job in `.github/workflows/ci.yml`, sets `INTEGRATION_DATABASE_URL`, and runs `*.integration.test.ts` there (they stay excluded from `pnpm -w test`). The CI step must also stay fast and fail on its own, so it can be marked advisory at first, following `docs/ci-required-checks.md`.
6. **Branch: decided.** All phases commit to `refactor/user-org-management` (from `feature` @ `1f31f6b`), in the worktree `../aggregator-dpg-user-org`. Five local-setup edits sit uncommitted in that worktree and are never staged.
