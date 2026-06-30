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
12. [Migration & rollout](#12-migration--rollout)
13. [Testing](#13-testing)

---

## 1. Goal

Let a **parent organisation** (e.g. "Enable India") register once, then have multiple **coordinators** (ground-team members) register under it. Each coordinator onboards participants (seekers/providers) and — for now — sees **only the data they onboarded**. Org-level visibility (an org owner seeing all its coordinators' data) is a **future** capability the model must not preclude.

Constraints that shaped the design:

- Minimise change. Today's aggregators already work; do not rework them.
- Do not change the signalstack schema.
- Preserve the `session.aggregator_id` scoping invariant (it is the core security boundary).

---

## 2. Key reframe

**Today's "aggregator" = "coordinator".** An aggregator is an entity that gets its own signalstack organisation, can log in, and onboards participants. That is exactly what a coordinator is. So the existing registration engine _is_ the coordinator flow; we reuse it and add a lighter parent-org concept above it.

**Domain (seeker/provider) is not an operator attribute.** It lives on the participant's item (`item_domain`) in signalstack. Neither the org nor the coordinator "has" a domain — a coordinator onboards both. This removes any need to store a domain on the org/coordinator.

---

## 3. Identity layers

| Layer             | What it is                                                                                                         | Signalstack org?                                  | Logs in?           | Approved by     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------ | --------------- |
| **Network admin** | Platform operator (existing)                                                                                       | —                                                 | existing           | —               |
| **Parent org**    | Keycloak **group** (+ org-owner KC user) — **no database row**; org metadata lives as group attributes             | **No**                                            | Not yet (deferred) | Network admin   |
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
2. A lighter **org** path that provisions a **Keycloak group** (org metadata as group attributes) + an org-owner KC user — **no DB table, no signalstack org**. The `registrations` row is the only DB trace; the org artifact itself is KC-only.
3. Two coordinator deltas: approver is **the selected org's owner**, plus an `ensureGroupMembership` step that joins the org's group and sets `parent_kc_group_id`.
4. Small schema additions (§5) and two new IdP adapter operations: `addToGroup`, `assignRole`.

---

## 5. Data model

### Parent org — **Keycloak group only, no database table**

There is **no `aggregator_orgs` table**. The org is a Keycloak **group**; its identity is the group id. All org metadata is carried as **group attributes**:

| Group attribute          | Description                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| group `name`/`path`      | The org's slug (KC enforces group-name uniqueness under the parent → free slug uniqueness). Display name also stored as an attribute.                 |
| `display_name`           | Org display name                                                                                                                                      |
| `owner_email`            | Org owner contact — coordinator approval emails are routed here                                                                                       |
| `owner_kc_sub`           | Keycloak user id of the org owner                                                                                                                     |
| `status`                 | `pending` (set by `ensureGroupCreate`) \| `active` (flipped by `ensureActivated`) \| `rejected`. The org dropdown filters groups on `status=active`.  |
| `source_registration_id` | The `registrations` id that provisioned this group — idempotency key so a retried `ensureGroupCreate` finds the existing group instead of duplicating |

**Why KC-only is acceptable here:** an org is a pure grouping — it has no signalstack org and no data-scoping role, so it never needs to be queried/joined/constrained the way a coordinator does. The org's _approval lifecycle_ is still recorded in the DB `registrations` row (the system-of-record for the process); the _provisioned artifact_ (the group) is an external resource — exactly like a coordinator's signalstack org is an external resource. The earlier "don't let an org id leak into `session.aggregator_id`" footgun is now structurally impossible: an org has no `aggregators` row and its id is a KC group id, never an aggregator id.

**Trade-off accepted:** the org dropdown and `owner_email` lookups read the **KC admin API** (list groups by `status=active`, read group attributes), not SQL. Org count is small and cacheable, so this is fine; just note it is a KC call, not a DB query.

### `aggregators` (existing = coordinator) — additions

| Column               | Type      | Description                                                                                                                                                                                                               |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent_kc_group_id` | text null | The Keycloak **group id** of the org this coordinator belongs to (not a DB FK — orgs have no table). `null` = orphan — **legacy aggregators only**; a new coordinator must select an org. Set by `ensureGroupMembership`. |

Plain text id (the KC group), nullable, **no FK** — the org has no DB row to reference. A coordinator joins **one** org for now (see §11). Everything else on `aggregators` is unchanged; coordinators keep their own `signalstackOrgId`.

**Org selection is mandatory for new coordinators** (`target_kc_group_id` required). `parent_kc_group_id = null` is reserved for pre-existing legacy aggregators (§11.2), never produced by a new registration. **Bootstrap order:** the first org must be admin-approved (its KC group `status=active`) before any coordinator can register — the coordinator form's org dropdown (KC groups where `status=active`) is empty until then.

### `registrations` (existing engine) — additions

| Column               | Type      | Description                                                                                                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`               | enum      | `'org'` \| `'coordinator'` — selects the provisioning step-set and approver                                                                                                                |
| `target_kc_group_id` | text null | Coordinator only — the KC group id of the org the applicant chose. Required for `kind='coordinator'`. The group's `status` must be `active` **at submit AND re-checked at approval** (§6). |

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
                        ensureOrgOwnerUser  (Keycloak user + org_owner role)
                        ensureGroupCreate   (KC group + attrs: display_name, owner_email,
                                             owner_kc_sub, source_registration_id, status=pending;
                                             add owner to group)
                        ensureWelcome
                        ensureActivated     (gate: above all done → group status=active)
```

There is **no `aggregator_orgs` row** — the org _is_ the KC group. `ensureGroupCreate` writes all org metadata as group attributes and is idempotent on `source_registration_id` (a retry finds the existing group instead of creating a duplicate). The group is created `status=pending`; only `ensureActivated` flips the group attribute to `active`, so a partial failure leaves it repairable. No `ensureSignalstackOrg`. The org owner gets a welcome email, but **console login is deferred** — the owner acts only via token links for now.

### Coordinator (`kind='coordinator'`)

```
Applicant (coordinator)         API / engine                 Org owner
1. Submit form + select org ──► registrations(kind='coordinator',
                                  target_kc_group_id=<active group>, submitted)
                                verification email ──────────► applicant
2. Verify email          ────► verified
                                admin notification (token) ──► THE ORG'S OWNER (group owner_email)
3. Approve (token)       ────► provisioning  (existing aggregator path + 1 step)
                                ensureGraduated        (aggregators row)
                                ensureIdpUser          (coordinator role)
                                ensureSignalstackOrg   (own signalstack org)
                                ensureGroupMembership  (join org KC group + set parent_kc_group_id)
                                ensureWelcome
                                ensureActivated        → active
```

The coordinator's submit form gains an org selector listing **KC groups with `status=active`** (read via the KC admin API). The approval JWT for a coordinator request is minted to the **org owner's** email (read from the target group's `owner_email` attribute via `target_kc_group_id`), not the network admin.

**Re-validate the org at approval (not just at submit).** An org's group can be rejected/retired between submit and approval. Before provisioning a coordinator, re-read the target group and check `status=active`. If it is not (or the group is gone), the request transitions to `declined` with reason `TARGET_ORG_INACTIVE` and the applicant is notified — provisioning never starts against a dead org. (The org owner's approval link itself becomes inert once the group is inactive, since it resolves through `target_kc_group_id`.)

**Reject path.** Either approver can decline (`intent=reject` in the same token mechanism): network admin for `kind='org'`, org owner for `kind='coordinator'`. A decline moves the registration to `declined` and emails the applicant. No KC user is enabled, no KC group is created (org), and no signalstack org or `aggregators` row is graduated (coordinator).

---

## 7. Provisioning steps (per kind)

| Step                    | org | coordinator | Notes                                                                                                                                                                                                                                                  |
| ----------------------- | --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ensureGraduated`       | —   | ✅          | creates `aggregators` row (status quo)                                                                                                                                                                                                                 |
| `ensureOrgOwnerUser`    | ✅  | —           | KC user + `org_owner` role                                                                                                                                                                                                                             |
| `ensureIdpUser`         | —   | ✅          | KC user + `coordinator` role                                                                                                                                                                                                                           |
| `ensureGroupCreate`     | ✅  | —           | create the org's KC group with attributes (`display_name`, `owner_email`, `owner_kc_sub`, `source_registration_id`, `status=pending`); **add the org owner to the group**. Idempotent on `source_registration_id`. This _is_ the org — no DB row.      |
| `ensureSignalstackOrg`  | —   | ✅          | coordinator's own signalstack org. `domains` on the upsert = all network domains (a coordinator has no single domain — see §2); the participant's `item_domain` carries the real seeker/provider split                                                 |
| `ensureGroupMembership` | —   | ✅          | add to org's KC group + set `parent_kc_group_id`. Idempotent across **both** stores: re-running re-asserts KC membership (no-op if present) and re-writes `parent_kc_group_id`; a half-done step (one store written, the other not) is healed on retry |
| `ensureWelcome`         | ✅  | ✅          |                                                                                                                                                                                                                                                        |
| `ensureActivated`       | ✅  | ✅          | gated on the kind's other steps being `done`; org → flips the group's `status` attribute to `active`                                                                                                                                                   |

**Cross-flow dependency:** `ensureGroupMembership` (coordinator) requires the org's KC group to already exist and be `active`. This is guaranteed because a coordinator may only select an `active` org (§6), and a group reaches `active` only after `ensureGroupCreate` has run. The step uses `target_kc_group_id` directly; if the group is missing/inactive, the step fails and the reconciler retries (it does not silently skip).

The reconciler, dead-letter, auto-reopen, and OTel behaviour are unchanged — they operate over whichever step-set the row's `kind` defines.

---

## 8. Auth, session, roles

- **Roles:** `org_owner`, `coordinator` (Keycloak realm/client roles).
- **Group:** one Keycloak **group per org** (created by `ensureGroupCreate`); members are the org owner and its coordinators.
- **Coordinator login:** OIDC code flow → token claims `aggregator_id` (the coordinator's own SS-org-backed aggregator) + `role=coordinator` → `session.aggregator_id` = that coordinator. With single-org membership there is no org switcher.
- **org_owner login:** deferred. `ensureOrgOwnerUser` creates the Keycloak user with the `org_owner` role, but the **portal does not expose an org-owner console** yet — there is no org dashboard route and the owner is not granted the portal client's login flow for it. The owner acts only via token email links (approving coordinators); the `/admin/**` gateway policy stays service-auth + per-action JWT (as in the existing design). Enabling org login later = adding the org dashboard + the role-gated read in §9, with no data migration.
- **Approval-token binding:** a coordinator approval JWT carries `sub = registration_id` **and** the `target_kc_group_id` it was minted for. The decision handler verifies the registration's `target_kc_group_id` matches the token's group claim, so an org owner's link can only decide **their own** org's coordinators — a leaked/forwarded token cannot approve a coordinator that selected a different org. (Network-admin org tokens carry no group claim.)
- **IdP adapter:** extend `IdpAdminAdapter` with `addToGroup(userId, groupId)` and `assignRole(userId, role)`. Keycloak is the concrete impl; the abstraction is unchanged otherwise.

---

## 9. Data scoping (now and future)

### Now — automatic per-coordinator isolation

Each coordinator has its **own** `aggregator_id` / signalstack org. Every handler already scopes by `session.aggregator_id`, and the dashboard reads signalstack scoped to the coordinator's org. So **Coordinator 1 sees only Coordinator 1's data, Coordinator 2 only theirs** — with **no new code or attribution column**. This is the status-quo behaviour, unchanged.

### Future — org-level view (deferred)

When org login ships, an `org_owner` session resolves its KC group id from the token and runs:

```sql
SELECT * FROM aggregators WHERE parent_kc_group_id = :group;   -- the org's coordinators
-- then union each coordinator's signalstack-org data
```

A plain filter on `parent_kc_group_id` → union of the child coordinators' signalstack orgs. The org list itself comes from KC (the group), but the coordinator membership it owns is a one-column query on `aggregators`. No migration, no new attribution field; the linkage recorded at coordinator approval is sufficient.

---

## 10. Out of scope / deferred

- **PII encryption at rest** — already "planned/later" in the base registration design; not part of this work.
- **Org-level data view + org console login** — future; the model supports it via `parent_kc_group_id` but we are not building the UI/auth now.
- **Multi-org coordinator** — single org now; a coordinator-to-org membership table is a later change if needed (see §11).
- **Signalstack schema changes** — none.
- **Migrating existing aggregators under orgs** — not forced; see §11.

---

## 11. Open items (defaults chosen; revisit if needed)

1. **Multi-org coordinator.** Default: **single org now** → `parent_kc_group_id` is one nullable column. Supporting a coordinator in multiple orgs later means replacing it with a `coordinator_org_memberships(aggregator_id, kc_group_id, role)` table (and/or native KC group membership) plus an org switcher at login. Deferred.
2. **Existing aggregators.** Default: they **become coordinators** by assigning the `coordinator` role and leaving `parent_kc_group_id = null` (orphan coordinators). They keep working untouched; no forced migration. An org can "claim" them later.
3. **Org owner who also onboards.** An `org_owner` has no signalstack org, so cannot onboard. The naive workaround — "also register as a coordinator with the same email" — **does not work**: the engine enforces unique email/phone, so a second registration with the owner's email is rejected at submit. Correct approach when needed: grant the **existing owner KC user** the `coordinator` role and graduate an `aggregators` row + signalstack org for it (one identity, two roles), rather than a second registration. Deferred — not built now; flagged so the uniqueness constraint isn't hit by surprise.
4. **Self-registration abuse surface.** Coordinator self-registration emails the org owner unsolicited. Add per-IP / per-email rate-limiting on submit, and (later) let an org owner block or report an applicant, so an owner can't be spammed with approval emails.

---

## 12. Migration & rollout

New schema is additive — no data rewrite. Deploy in order:

1. **Migration (additive, small):** add `aggregators.parent_kc_group_id` (text, nullable); add `registrations.kind` and `registrations.target_kc_group_id` (text, nullable). **No `aggregator_orgs` table** — the org lives in Keycloak.
2. **`kind` backfill + default:** `kind` is `NOT NULL`. Backfill all existing `registrations` rows to `'coordinator'` (today's aggregator = coordinator, §2) and set the column **default** `'coordinator'` so in-flight rows mid-deploy are valid. `target_kc_group_id` stays null on legacy rows.
3. **Existing aggregators:** untouched — `parent_kc_group_id = null` (orphan coordinators, §11.2). Grant the `coordinator` role lazily (at next login or via a one-off backfill); not required for them to keep working.
4. **Ship logic** (kind-aware step-sets, KC-group provisioning, org dropdown from KC, approver routing) only after the columns exist and are backfilled.
5. **Rollback:** the new columns are inert to the old code path (old code never reads `kind`/`parent_kc_group_id`), so a logic rollback is safe without dropping schema. KC groups created before a rollback are harmless orphans.

No signalstack migration (§5). No forced re-parenting of existing aggregators.

---

## 13. Testing

Engine-level behaviour (FSM, reconciler, dead-letter, dedup) is already covered by the base registration suite; these tests cover the **delta**:

- **Step-set selection by `kind`** — `kind='org'` runs the org steps (no `ensureSignalstackOrg`/`ensureGraduated`, **no DB org row**); `kind='coordinator'` runs the aggregator path **plus** `ensureGroupMembership`.
- **Org provisioning is KC-only** — after org approval, a KC group exists with `status=active` + the org attributes, and there is **no `aggregator_orgs` row** (no such table). `ensureGroupCreate` is idempotent on `source_registration_id` (retry finds the existing group).
- **Approver routing** — org request → token to `ADMIN_EMAILS`; coordinator request → token to the target group's `owner_email` attribute (resolved via `target_kc_group_id`).
- **Token binding (§8)** — a coordinator token minted for group A cannot approve a coordinator whose `target_kc_group_id` is group B (org-mismatch rejection).
- **Org inactive at approval (§6, G3)** — target group rejected/retired (or gone) after submit → coordinator approval declines with `TARGET_ORG_INACTIVE`, no provisioning runs.
- **Uniqueness collision (§11.3, G4)** — registering a coordinator with an existing org owner's email is rejected at submit.
- **Bootstrap (§G2)** — coordinator submit when no KC group has `status=active` is rejected; first org must be admin-approved first.
- **Owner group membership (§7, G5)** — after org approval, the owner KC user is a member of the org group.
- **`ensureGroupMembership` idempotency (§7)** — re-running after a half-done step (KC joined but `parent_kc_group_id` unset, and vice versa) converges; reconciler heals.
- **Per-coordinator isolation (§9)** — coordinator 1 cannot read coordinator 2's data; `session.aggregator_id` scoping holds with `parent_kc_group_id` set.
