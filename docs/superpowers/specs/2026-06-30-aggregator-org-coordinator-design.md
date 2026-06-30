# Aggregator Org + Coordinator Design

**Audience:** Product team and developers extending the aggregator registration subsystem to support a parent **organisation** that owns multiple **coordinators**.

**Status:** Design (approved for spec; implementation plan to follow).

**Relationship to existing work:** This design **extends** the aggregator registration engine described in `docs/registration-design.md` (branch `agg-registration-v2`). It reuses that engine wholesale and adds an org/coordinator layer on top. Read that document first — this one only describes the delta.

---

## Contents

1. [Goal](#1-goal)
2. [Key reframe](#2-key-reframe)
3. [Identity layers](#3-identity-layers)
4. [What we reuse vs add](#4-what-we-reuse-vs-add)
5. [Data model](#5-data-model)
6. [Registration + approval flows](#6-registration--approval-flows)
7. [Provisioning steps (per kind)](#7-provisioning-steps-per-kind)
8. [Auth, session, roles](#8-auth-session-roles)
9. [Data scoping (now and future)](#9-data-scoping-now-and-future)
10. [Out of scope / deferred](#10-out-of-scope--deferred)
11. [Open items](#11-open-items)

---

## 1. Goal

Let a **parent organisation** (e.g. "Enable India") register once, then have multiple **coordinators** (ground-team members) register under it. Each coordinator onboards participants (seekers/providers) and — for now — sees **only the data they onboarded**. Org-level visibility (an org owner seeing all its coordinators' data) is a **future** capability the model must not preclude.

Constraints that shaped the design:

- Minimise change. Today's aggregators already work; do not rework them.
- Do not change the signalstack schema.
- Preserve the `session.aggregator_id` scoping invariant (it is the core security boundary).

---

## 2. Key reframe

**Today's "aggregator" = our "coordinator".** An aggregator is an entity that gets its own signalstack organisation, can log in, and onboards participants. That is exactly what a coordinator is. So the existing registration engine _is_ the coordinator flow; we reuse it and add a lighter parent-org concept above it.

**Domain (seeker/provider) is not an operator attribute.** It lives on the participant's item (`item_domain`) in signalstack. Neither the org nor the coordinator "has" a domain — a coordinator onboards both. This removes any need to store a domain on the org/coordinator.

---

## 3. Identity layers

| Layer             | What it is                                                                                                         | Signalstack org?                                  | Logs in?           | Approved by     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------ | --------------- |
| **Network admin** | Platform operator (existing)                                                                                       | —                                                 | existing           | —               |
| **Parent org**    | `aggregator_orgs` row + Keycloak **group**                                                                         | **No**                                            | Not yet (deferred) | Network admin   |
| **Coordinator**   | Keycloak user (`coordinator` role) in the org's group; **= an `aggregators` row** with its **own** signalstack org | **Yes** (status quo)                              | Yes                | The org's owner |
| **Participant**   | Signalstack `user` account + item (`created_by = account`)                                                         | Lives **under the coordinator's** signalstack org | n/a                | n/a             |

A participant account is attributed to the coordinator's signalstack org via the existing `user.onboarded_by_org_id`. No new attribution field is required (see §9).

---

## 4. What we reuse vs add

### Reuse wholesale (from `agg-registration-v2`)

- **Write-first + reconciler** (DB is source of truth; on-demand repair).
- **Application FSM** (`submitted → verified → provisioning → active`, plus `declined`/`abandoned`).
- **Dedup / idempotency** (SHA-256 fingerprint; silent `202`).
- **Token-based approval, no login** (approve/decline JWT in email, `intent` claim, confirmation page, `INTENT_MISMATCH`, "already decided").
- **Provisioning step framework** (`ensure-*` steps, per-step `provision_state`, dead-letter, auto-reopen).
- **`IdpAdminAdapter`** abstraction.
- **OpenTelemetry** state-transition events; `previous_state` on the row.

### Add (the org/coordinator delta)

1. A **`kind` discriminator** on `registrations` (`'org' | 'coordinator'`); the provisioning step-set and approver vary by kind.
2. A lighter **org** path that graduates into a new **`aggregator_orgs`** table and creates a Keycloak group (no signalstack org).
3. Two coordinator deltas: approver is **the selected org's owner**, plus an `ensureGroupMembership` step that joins the org's group and sets `parent_org_id`.
4. Small schema additions (§5) and two new IdP adapter operations: `addToGroup`, `assignRole`.

---

## 5. Data model

### `aggregator_orgs` (NEW) — the parent org

| Column                     | Type        | Description                                                                                                                         |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | uuid pk     | Parent-org id                                                                                                                       |
| `name`                     | text        | Org display name                                                                                                                    |
| `slug`                     | text unique | URL-safe identifier                                                                                                                 |
| `owner_email`              | text        | Org owner contact (approval emails go here)                                                                                         |
| `owner_kc_sub`             | text        | Keycloak user id of the org owner (set on approval)                                                                                 |
| `keycloak_group_id`        | text        | The org's Keycloak group (set on approval)                                                                                          |
| `status`                   | enum        | `pending` (created by `ensureGraduatedOrg`) \| `active` (flipped by `ensureActivated`) \| `rejected` — mirrors `aggregators.status` |
| `approved_by`              | text        | Network-admin identity that approved                                                                                                |
| `source_registration_id`   | uuid        | FK to `registrations` — idempotency key for graduation retries                                                                      |
| `created_at`, `updated_at` | timestamp   |                                                                                                                                     |

Kept **separate** from `aggregators` on purpose: an org is a tenant/grouping with no signalstack org and no data-scoping role. Putting it in `aggregators` would let an org id leak into `session.aggregator_id` scoping — a security footgun. Separation makes that impossible and keeps the future org rollup a simple FK join.

### `aggregators` (existing = coordinator) — additions

| Column          | Type                             | Description                                                                                                                  |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `parent_org_id` | uuid null → `aggregator_orgs.id` | The org this coordinator belongs to. `null` = orphan (legacy aggregators, or none selected). Set by `ensureGroupMembership`. |

Single nullable column because a coordinator joins **one** org for now (see §11). Everything else on `aggregators` is unchanged; coordinators keep their own `signalstackOrgId`.

### `registrations` (existing engine) — additions

| Column          | Type                             | Description                                                                 |
| --------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `kind`          | enum                             | `'org'` \| `'coordinator'` — selects the provisioning step-set and approver |
| `target_org_id` | uuid null → `aggregator_orgs.id` | Coordinator only — the org the applicant chose (must be `approved`/active)  |

`provision_state` keys differ by `kind` (§7). No other registration columns change.

### Signalstack

**No schema change.** Coordinator = own signalstack org (status quo). Participant accounts carry `onboarded_by_org_id` (the coordinator's signalstack org) as today.

---

## 6. Registration + approval flows

Both flows ride the existing FSM and token-approval mechanism; only the approver and the provisioning step-set differ.

### Org (`kind='org'`)

```
Applicant (org)                 API / engine                 Network admin
1. Submit org form ───► registrations(kind='org', submitted)
                        verification email ─────────────────► applicant
2. Verify email   ───► verified
                        admin notification (token link) ────► NETWORK ADMIN
3. Approve (token) ───► provisioning
                        ensureGraduatedOrg  (create aggregator_orgs row, status = pending)
                        ensureOrgOwnerUser  (Keycloak user + org_owner role; write owner_kc_sub)
                        ensureGroupCreate   (Keycloak group; write keycloak_group_id)
                        ensureWelcome
                        ensureActivated     (gate: above all done → status active)
```

**`ensureGraduatedOrg` runs first** so the `aggregator_orgs` row exists before `ensureOrgOwnerUser` and `ensureGroupCreate` write `owner_kc_sub` / `keycloak_group_id` onto it (same "graduate first" rationale as the base design's `ensureGraduated`). It creates the row as `pending`; only `ensureActivated` flips it to `active`, so a partial failure leaves the row repairable. No `ensureSignalstackOrg`, no `aggregators` row. The org owner gets a welcome email, but **console login is deferred** — the owner acts only via token links for now.

### Coordinator (`kind='coordinator'`)

```
Applicant (coordinator)         API / engine                 Org owner
1. Submit form + select org ──► registrations(kind='coordinator',
                                  target_org_id=<active org>, submitted)
                                verification email ──────────► applicant
2. Verify email          ────► verified
                                admin notification (token) ──► THE ORG'S OWNER (owner_email)
3. Approve (token)       ────► provisioning  (existing aggregator path + 1 step)
                                ensureGraduated        (aggregators row)
                                ensureIdpUser          (coordinator role)
                                ensureSignalstackOrg   (own signalstack org)
                                ensureGroupMembership  (join org group + set parent_org_id)
                                ensureWelcome
                                ensureActivated        → active
```

The coordinator's submit form gains an org selector listing **active** `aggregator_orgs`. The approval JWT for a coordinator request is minted to the **org owner's** email (resolved from `aggregator_orgs.owner_email` via `target_org_id`), not the network admin.

---

## 7. Provisioning steps (per kind)

| Step                    | org | coordinator | Notes                                        |
| ----------------------- | --- | ----------- | -------------------------------------------- |
| `ensureGraduated`       | —   | ✅          | creates `aggregators` row (status quo)       |
| `ensureGraduatedOrg`    | ✅  | —           | creates `aggregator_orgs` row                |
| `ensureOrgOwnerUser`    | ✅  | —           | KC user + `org_owner` role                   |
| `ensureIdpUser`         | —   | ✅          | KC user + `coordinator` role                 |
| `ensureGroupCreate`     | ✅  | —           | create KC group; store `keycloak_group_id`   |
| `ensureSignalstackOrg`  | —   | ✅          | coordinator's own signalstack org            |
| `ensureGroupMembership` | —   | ✅          | add to org's KC group + set `parent_org_id`  |
| `ensureWelcome`         | ✅  | ✅          |                                              |
| `ensureActivated`       | ✅  | ✅          | gated on the kind's other steps being `done` |

**Cross-flow dependency:** `ensureGroupMembership` (coordinator) requires the org's `keycloak_group_id` to already exist. This is guaranteed because a coordinator may only select an **`active`** org (§6), and an org reaches `active` only after `ensureGroupCreate` has run. The step reads `keycloak_group_id` from the `aggregator_orgs` row referenced by `target_org_id`; if it is somehow absent, the step fails and the reconciler retries (it does not silently skip).

The reconciler, dead-letter, auto-reopen, and OTel behaviour are unchanged — they operate over whichever step-set the row's `kind` defines.

---

## 8. Auth, session, roles

- **Roles:** `org_owner`, `coordinator` (Keycloak realm/client roles).
- **Group:** one Keycloak **group per org** (created by `ensureGroupCreate`); members are the org owner and its coordinators.
- **Coordinator login:** OIDC code flow → token claims `aggregator_id` (the coordinator's own SS-org-backed aggregator) + `role=coordinator` → `session.aggregator_id` = that coordinator. With single-org membership there is no org switcher.
- **org_owner login:** deferred. `ensureOrgOwnerUser` creates the Keycloak user with the `org_owner` role, but the **portal does not expose an org-owner console** yet — there is no org dashboard route and the owner is not granted the portal client's login flow for it. The owner acts only via token email links (approving coordinators); the `/admin/**` gateway policy stays service-auth + per-action JWT (as in the existing design). Enabling org login later = adding the org dashboard + the role-gated read in §9, with no data migration.
- **IdP adapter:** extend `IdpAdminAdapter` with `addToGroup(userId, groupId)` and `assignRole(userId, role)`. Keycloak is the concrete impl; the abstraction is unchanged otherwise.

---

## 9. Data scoping (now and future)

### Now — automatic per-coordinator isolation

Each coordinator has its **own** `aggregator_id` / signalstack org. Every handler already scopes by `session.aggregator_id`, and the dashboard reads signalstack scoped to the coordinator's org. So **Coordinator 1 sees only Coordinator 1's data, Coordinator 2 only theirs** — with **no new code or attribution column**. This is the status-quo behaviour, unchanged.

### Future — org-level view (deferred)

When org login ships, an `org_owner` session resolves the org and runs:

```sql
SELECT * FROM aggregators WHERE parent_org_id = :org;   -- the org's coordinators
-- then union each coordinator's signalstack-org data
```

A plain FK join over `parent_org_id` → union of the child coordinators' signalstack orgs. No migration, no new attribution field; the linkage recorded at coordinator approval is sufficient.

---

## 10. Out of scope / deferred

- **PII encryption at rest** — already "planned/later" in the base registration design; not part of this work.
- **Org-level data view + org console login** — future; the model supports it via `parent_org_id` but we are not building the UI/auth now.
- **Multi-org coordinator** — single org now; a coordinator-to-org membership table is a later change if needed (see §11).
- **Signalstack schema changes** — none.
- **Migrating existing aggregators under orgs** — not forced; see §11.

---

## 11. Open items (defaults chosen; revisit if needed)

1. **Multi-org coordinator.** Default: **single org now** → `parent_org_id` is one nullable column. Supporting a coordinator in multiple orgs later means replacing `parent_org_id` with a `coordinator_org_memberships(aggregator_id, aggregator_org_id, role)` table and adding an org switcher at login. Deferred.
2. **Existing aggregators.** Default: they **become coordinators** by assigning the `coordinator` role and leaving `parent_org_id = null` (orphan coordinators). They keep working untouched; no forced migration. An org can "claim" them later.
3. **Org owner who also onboards.** An `org_owner` has no signalstack org, so cannot onboard. If an org owner needs to onboard, they also register as a coordinator under their org. Acceptable for now; revisit if common.
