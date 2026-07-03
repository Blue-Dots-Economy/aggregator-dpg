# Aggregator Org + Coordinator Design — v2

**Date:** 2026-06-30
**Status:** Design — pending user review before the implementation plan
**Supersedes:** `2026-06-30-aggregator-org-coordinator-design.md` (v1, same branch)
**Branch:** `design/aggregator-org-coordinator` (based on `feature`)
**Goal:** same as v1 — a parent **org** registers once; multiple **coordinators** register under it; each coordinator onboards participants and sees only their own data; org-level visibility is a future capability the model must not preclude.

This v2 keeps v1's core shape (feature-flagged, additive, reuse-the-existing-flow, no signalstack schema change) and revises it to close the issues found in review. **Read Part A for what changed and why; Part B is the full, self-contained spec.**

---

# Part A — Issues addressed in v2 (delta from v1)

Each item below states the v1 problem, the v2 resolution, and the spec section that implements it. Three resolutions were chosen by the reviewer after the review (C1, C2, C6 — marked **[decision]**).

## A1 — Org→coordinator relationship had two sources of truth _(was: HIGH)_ **[decision]**

- **v1 problem.** The org→coordinator link was stored **twice**: as `aggregators.parent_kc_group_id` (DB) _and_ as Keycloak group membership (the coordinator user added to the org's KC group). Every consumer — the future org-view query (§10) and the approval-token binding (§9) — read the **DB column**, while the membership write was a **soft-fail** provisioning step. A coordinator could commit to `active` while silently missing from the KC group, with nothing noticing until org-console login shipped. Two authorities for one relationship, one allowed to fail silently → guaranteed drift.
- **v2 resolution.** **The DB column is the single authority.** The org→coordinator relationship is `aggregators.parent_org_id` (a real FK, see A2). **Coordinators are NOT added to the org's KC group in v1** — there is no "add to org group" provisioning step. KC-native group membership is re-introduced only when the org console actually needs KC group authz (deferred with that feature), at which point it is a backfill from `parent_org_id`, not a parallel source of truth.
- **Where:** §5 (data model), §8 (provisioning — membership step removed), §9 (token binding reads `parent_org_id`), §10 (org-view query reads `parent_org_id`).

## A2 — Org as KC-group-only made Keycloak a business-record store _(was: structural / MEDIUM)_ **[decision]**

- **v1 problem.** Orgs (pending/active/rejected + all metadata) lived **only** as KC groups, and `aggregators.parent_kc_group_id` referenced a group id with **no FK and no cross-store referential integrity**. A KC restore out of sync with the app DB could leave coordinator rows dangling against group ids that no longer exist (or a re-created group with a new id). The org dropdown and owner-email lookup also required **KC admin API** calls (and KC group search doesn't natively filter by a custom `status` attribute — it meant list-all-groups + read-attributes + filter client-side). And org `status` as a KC group **attribute** has no atomic compare-and-set, weakening the approval single-use guard (see A3).
- **v2 resolution.** Introduce a **thin `aggregator_orgs` DB table** as the org **system of record** (id, slug, display_name, owner_email, owner_kc_sub, status, kc_group_id, timestamps). `aggregators.parent_org_id` is a real **FK → `aggregator_orgs.id`** → referential integrity restored. The KC group is **demoted to an authz mirror** (created alongside the row, holds the org_owner; carries no business state that the app reads). The org dropdown and owner-email lookup become **plain SQL** (`WHERE status='active'`) — no KC admin API on the hot path. If a KC restore skews, the DB relationship survives; the group is re-derivable.
- **Where:** §5 (new `aggregator_orgs` table; KC group demoted), §6 (SQL dropdown/owner lookup), §13 (migration: one new table + one FK column).

## A3 — Org approval single-use guard was weaker than the coordinator's _(was: MEDIUM)_

- **v1 problem.** The coordinator decision could use a transactional `UPDATE … WHERE status='pending'` (real atomic guard), but the **org** status lived as a KC group attribute with no atomic CAS, so a double-clicked approve link raced on read-modify-write; safety rested entirely on every step being idempotent.
- **v2 resolution.** With org state in `aggregator_orgs` (A2), the org decision uses the **same atomic CAS** as the coordinator: `UPDATE aggregator_orgs SET status='active' WHERE id=:id AND status='pending'` (rows-affected = the single-use guard). Uniform, transactional, race-safe.
- **Where:** §6 (org approve), §8 (status commit row).

## A4 — Org-owner-who-also-onboards failed with a raw 409 _(was: MEDIUM; still deferred, error handling specified)_

- **v1 problem.** A common real case (the person who registers the org is often also a ground coordinator) hit the unique email/phone check and got a raw `409 USER_EXISTS`, with the actual remedy (graduate the owner to a coordinator) only described in prose.
- **v2 resolution.** Still deferred for full support, but v2 **specifies the failure UX**: a coordinator submit whose email/phone matches an **org owner** returns a distinct, machine-readable `OWNER_ALREADY_REGISTERED` with copy directing them to request coordinator access, **not** a generic duplicate error. The graduation path (grant the existing owner KC user the `coordinator` role + create an `aggregators` row + signalstack org — one identity, two roles) is documented as the intended implementation when built.
- **Where:** §6 (uniqueness handling), §12 (open item 3).

## A5 — Dropdown / owner lookup hit the KC admin API _(was: MEDIUM)_

- **Resolved by A2.** Both are now SQL queries on `aggregator_orgs`. Noted separately because it removes a KC-admin-API dependency from the registration hot path and removes the "KC can't filter by custom attribute" feasibility risk entirely.

## A6 — Coordinator self-registration spam surface _(was: LOW/MEDIUM)_ **[decision]**

- **v1 problem.** Active orgs appear in a public dropdown, so anyone could submit a coordinator registration under any org and trigger an unsolicited approval email to that org's owner.
- **v2 resolution.** **Keep the self-registration model** (lowest change; the owner is still the approval gate), and **specify rate limiting** as in-scope, not optional: per-IP and per-email throttling on the coordinator submit endpoint, plus a per-(org, email) dedupe so repeat submits refresh the pending record (§7) rather than re-notify. **Invite-based onboarding** (owner invites → applicant completes via token; no public org dropdown for coordinators) is documented as the planned successor in §12, not built now.
- **Where:** §6 (rate limiting), §12 (open item 4).

## A7 — Terminology overload ("aggregator owner" vs coordinator) _(was: MINOR)_

- **v1 problem.** The flow diagram labelled the org-form filler "Aggregator owner," but per the reframe an org owner is **not** an aggregator (aggregator = coordinator). "Aggregator owner approves coordinator" reads as a coordinator approving a coordinator.
- **v2 resolution.** Locked vocabulary used consistently across spec, API, and UI: **`org`** / **`org owner`** vs **`coordinator`**; **`network admin`** for the platform operator. The word "aggregator" is retained **only** for the existing DB table/identity (`aggregators` = coordinator) and is **kept out of user-facing copy**. A glossary is added (§0).
- **Where:** §0 (glossary), used throughout.

## A8 — Org-owner KC user is enabled but cannot log in _(was: LOW; documented)_

- **v2 note.** The org-owner KC user is still created (disabled) at submit and enabled with the `org_owner` role at approval, even though console login is deferred. v2 states explicitly that it exists **only** to avoid a later migration when the org console ships; in v1/v2 the owner acts solely via signed token email links. (See §9.)

## A9 — Rejected org leaves a name collision _(was: LOW; handled)_

- **v1 problem.** Org slug uniqueness spanned pending/active/rejected; a `rejected` org left a named record that could collide with a later registration until cleanup pruned it.
- **v2 resolution.** Slug uniqueness is enforced **only over non-terminal rows** via a partial unique index (`UNIQUE (slug) WHERE status IN ('pending','active')`). A `rejected` org never blocks a new slug. The §7 recovery still lets a `pending`/`rejected` owner-email refresh its own record. A genuine collision returns `ORG_SLUG_TAKEN`, not a raw store error.
- **Where:** §5 (partial unique index), §6 (error mapping).

## A10 — Diagram vs spec wording ("created on approve") _(was: LOW; aligned)_

- **v2 note.** The org `aggregator_orgs` row **and** its KC group are created at **submit** (`status='pending'`); approval **flips** to `active` ("org goes live"). The diagram's "created automatically by system" describes go-live, not creation. Wording aligned so no one implements create-on-approve.

---

# Part B — Full design spec (v2)

## 0. Glossary (locked vocabulary — A7)

| Term                 | Meaning                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network admin**    | Platform operator. Approves orgs. Acts via token links only (no console change).                                                                                                                  |
| **Org** (parent org) | A parent organisation (e.g. "Enable India"). Has an `aggregator_orgs` row (system of record) + a mirrored KC group + an org-owner KC user. **No signalstack org, no data-scoping role, no type.** |
| **Org owner**        | The person who registers an org and approves its coordinators. KC user with `org_owner` role. Acts via token links (console deferred).                                                            |
| **Coordinator**      | Exactly today's "aggregator": an `aggregators` row with its **own signalstack org**, can log in, onboards participants. Has a `type` (seeker/provider). Belongs to **one** org.                   |
| **Participant**      | Signalstack `user` + item, onboarded under a coordinator's signalstack org (`user.onboarded_by_org_id`).                                                                                          |
| **`aggregators`**    | The existing table/identity. In this design an `aggregators` row **= a coordinator**. The word "aggregator" is not used in user-facing copy.                                                      |

---

## 1. Goal & constraints

Let a parent **org** register once, then have multiple **coordinators** register under it. Each coordinator onboards participants and, for now, sees **only the data they onboarded**. Org-level visibility (an owner seeing all its coordinators' data) is **future** and must not be precluded.

Constraints (unchanged from v1):

- **Minimise change.** Build on today's flow; do **not** adopt the `agg-registration-v2` engine (only its §7 recovery behaviour is carried).
- **No signalstack schema change.**
- **Preserve the `session.aggregator_id` scoping invariant** — the core security boundary.
- **The hierarchy is optional per instance** — a flag decides (§2).

> v2 change vs v1: the org now has a **thin DB table** (A2) and the org→coordinator link is a **DB FK only** (A1). Both are still additive and inert when the flag is off.

---

## 2. Feature flag — org hierarchy on/off per instance

Gated by one startup flag; some instances want org→coordinator, some want today's flat aggregator.

- **Flag:** `ORG_HIERARCHY_ENABLED` (boolean env var in `packages/config` / `config.ts`, **default `false`**). Read **once at startup, per running instance** (configuration-discipline rule); flipping needs a restart. Two instances of the same network can differ.

- **OFF (default) — today's behaviour, unchanged:** single flat registration → one `aggregators` row → **network-admin** approval → active. No org tab, no org dropdown, no `aggregator_orgs` rows, no KC org groups, no coordinator concept. `parent_org_id` stays `null`. 100% backward compatible.

- **ON:** two registration entry points (Org tab + Coordinator tab), org dropdown, org-owner approval routing for coordinators, `aggregator_orgs` rows + mirrored KC groups, `aggregators.parent_org_id` populated.

The new schema (§5) is **additive and inert when the flag is off** — the table and column exist everywhere but are only written/read when `ORG_HIERARCHY_ENABLED=true`. §3–§10 describe **flag-ON** behaviour; flag-OFF is "the current flow as-is".

---

## 3. Key reframe (unchanged from v1)

**Today's "aggregator" = "coordinator".** An aggregator gets its own signalstack org, logs in, and onboards participants — that is a coordinator. So the existing registration flow **is** the coordinator flow; we reuse it and add a lighter parent-org concept above it (when the flag is on).

**Type (seeker/provider) lives on the coordinator, not the org.** The coordinator keeps today's `aggregators.type` + `actor_type` + KC `aggregator_type` attribute, with single-type enforcement — **unchanged**. What's new: the **org has no type** — an org spans both, so coordinators of different types sit under one org. (A participant's `item_domain` in signalstack is a separate item-level field, unaffected.)

---

## 4. Identity layers

| Layer             | What it is                                                                                                          | DB row?                             | Signalstack org?                        | Logs in?                 | Approved by     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------- | ------------------------ | --------------- |
| **Network admin** | Platform operator (existing)                                                                                        | —                                   | —                                       | No (token links only)    | —               |
| **Org**           | `aggregator_orgs` row (system of record) **+** mirrored KC group **+** org-owner KC user                            | **Yes** (`aggregator_orgs`)         | **No**                                  | Owner not yet (deferred) | Network admin   |
| **Coordinator**   | KC user (`coordinator` role) **= an `aggregators` row** with its **own** signalstack org; `parent_org_id` → its org | **Yes** (`aggregators`, status quo) | **Yes** (status quo)                    | Yes                      | The org's owner |
| **Participant**   | Signalstack `user` + item (`created_by = account`)                                                                  | —                                   | Under the coordinator's signalstack org | n/a                      | n/a             |

A participant is attributed to the coordinator's signalstack org via the existing `user.onboarded_by_org_id` — no new attribution field (§10).

When the flag is OFF, only **Network admin** and a flat **coordinator** (= an `aggregators` row, `parent_org_id = null`) exist.

> v2 change vs v1: the Org layer now **has a DB row** (`aggregator_orgs`), not "KC group only" (A2).

---

## 5. Data model

### 5.1 `aggregator_orgs` — **new, thin, system of record** (A2)

The org is a small DB row. The KC group is a **mirror** for future authz, not a store of business state.

| column         | type                               | notes                                                                             |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `id`           | uuid PK                            | the org id; what `aggregators.parent_org_id` references                           |
| `slug`         | text NOT NULL                      | URL/display slug; uniqueness enforced over non-terminal rows (see index)          |
| `display_name` | text NOT NULL                      | org display name                                                                  |
| `state`        | text NULL                          | geographic/other detail collected on the org form                                 |
| `owner_email`  | text NOT NULL                      | org owner contact; coordinator approval emails route here                         |
| `owner_kc_sub` | text NULL                          | KC user id of the org owner (set at submit)                                       |
| `kc_group_id`  | text NULL                          | the mirrored KC group id (authz mirror; not read for scoping)                     |
| `status`       | text NOT NULL                      | `pending` (at submit) \| `active` (admin approved) \| `rejected` (admin declined) |
| `created_at`   | timestamptz NOT NULL default now() |                                                                                   |
| `updated_at`   | timestamptz NOT NULL default now() | bumped on refresh (§7) and decision                                               |

**Indexes / constraints:**

- `UNIQUE (slug) WHERE status IN ('pending','active')` — partial unique index; a `rejected` org never blocks a new slug (A9).
- `(status)` — drives the active-org dropdown (`WHERE status='active'`).
- `(owner_email)` — owner lookup + §7 recovery match.

**Why a DB row (not KC-only):** referential integrity for `parent_org_id` (a real FK), SQL dropdown/owner lookup (no KC admin API on the hot path), and an **atomic status CAS** for the single-use approval guard (A3). The KC group still exists (mirror) so the future org console needs no migration; it carries the org owner's membership and `org_owner` role, nothing the app reads for scoping.

### 5.2 `aggregators` (existing = coordinator) — additions

| column          | type      | notes                                                                                                                                                                                                 |
| --------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parent_org_id` | uuid NULL | **FK → `aggregator_orgs.id`.** The org this coordinator belongs to. Set at **submit** from the chosen org. `null` = flat coordinator (flag off) or legacy orphan. Only populated when the flag is on. |

A real FK (v2 change vs v1's bare text column). A coordinator joins **one** org for now (§12). Everything else on `aggregators` is unchanged — coordinators keep their own `type`, `actor_type`, `signalstackOrgId`. The pending coordinator **is** the `aggregators` row with `status=pending` (status quo) — no separate registration record.

**When the flag is on, org selection is mandatory for new coordinators.** **Bootstrap order:** the first org must be admin-approved (`aggregator_orgs.status='active'`) before any coordinator can register — the coordinator form's org dropdown (`SELECT … WHERE status='active'`) is empty until then.

### 5.3 Signalstack

**No schema change.** Coordinator = own signalstack org (status quo). Participant accounts carry `onboarded_by_org_id` (the coordinator's signalstack org) as today.

---

## 6. Registration + approval flows

Both flows use the **current** signed-token, no-login approval mechanism (mint approve/reject JWTs → email → HTML confirm page → decision POST → single-use guard). v2 differs from v1 only in the **store** (DB rows, not KC attributes) and in **dropping coordinator group membership**. All of this section is flag-ON behaviour.

### 6.1 Org (`kind='org'`)

```
Applicant (org)                  API                              Network admin
1. Submit org form ───► INSERT aggregator_orgs (status=pending)
                        + create mirrored KC group
                        + org-owner KC user (disabled)
                        verification email ───────────────────────► applicant
2. Verify email   ───► (owner email verified)
                        admin notification (token link) ──────────► NETWORK ADMIN
3. Approve (token)───►  UPDATE aggregator_orgs SET status='active'
                          WHERE id=:id AND status='pending'   [atomic single-use guard]
                        enable owner KC user + org_owner role
                        welcome email
```

- The `aggregator_orgs` row is the org across its lifecycle — `pending` at submit, `active` on approval ("org goes live"). The KC group + disabled owner user are created at submit (A10). No signalstack org.
- **Single-use guard = the atomic CAS** (rows-affected on the `WHERE … status='pending'` update). A double-clicked link no-ops the second time (A3).
- Console login for the owner is **deferred** (§9); the owner acts via token links only.
- **Reject** → `UPDATE … SET status='rejected'`; owner stays disabled; applicant emailed.

### 6.2 Coordinator (`kind='coordinator'` — today's aggregator flow + org link)

```
Applicant (coordinator)          API                              Org owner
1. Submit form + select org ──►  validate org (SELECT … status='active')
                                 INSERT aggregators (status=pending,
                                   parent_org_id = chosen org, type = seeker/provider)
                                 + KC user (disabled, decision_made=pending)
                                 verification email ──────────────► applicant
2. Verify email          ────►   verified
                                 approval token ─────────────────► THE ORG'S OWNER
                                                                    (aggregator_orgs.owner_email)
3. Approve (token)       ────►   re-validate org status='active'             [hard-gate]
                                 signalstack upsert (own org, domains=type)  [hard-gate]
                                 enable KC user                              [hard-gate]
                                 decision_made = approved                    [soft-fail]
                                 stamp signalstack_org_id (KC + DB)          [soft-fail]
                                 UPDATE aggregators SET status='active'
                                   WHERE id=:id AND status='pending'         [atomic commit]
                                 welcome email
```

This is **exactly today's approve sequence** (hard-gated signalstack upsert + KC enable, soft-fail attribute writes, atomic status flip as the "decided" commit) — **no "add to org KC group" step** (A1). The org→coordinator link is `parent_org_id`, set at submit.

- The coordinator submit form's org selector lists orgs from **SQL** (`aggregator_orgs WHERE status='active'`) — no KC admin API (A5).
- The approval JWT is minted to the **org owner's** `owner_email` (read from the org row), not the network admin.
- **Re-validate the org at approval** (A re-read, not just submit): a row can be `rejected`/retired between submit and approval. Before provisioning, confirm `status='active'`; if not (or gone), decline with `TARGET_ORG_INACTIVE` and notify the applicant — provisioning never runs against a dead org.

### 6.3 Uniqueness, recovery, rate limiting

- **Uniqueness vs status** (the §7 fix): email/phone matching an **`active`** record → genuine `409`. Matching a **`pending`/`rejected`** record (coordinator row or org row, by owner_email) → **refresh** that record + re-mint token (§7), not a conflict.
- **Org-owner-also-coordinator** (A4): a coordinator submit whose email/phone matches an **org owner** returns `OWNER_ALREADY_REGISTERED` (distinct from `USER_EXISTS`), with copy pointing to "request coordinator access". Graduation path deferred (§12).
- **Slug collision** (A9): a new org slug colliding with a non-terminal row returns `ORG_SLUG_TAKEN`.
- **Rate limiting** (A6): per-IP and per-email throttling on the coordinator submit endpoint; per-(org, email) dedupe so repeat submits refresh rather than re-notify the owner.

`network` is always server-derived. Error codes are machine-readable; routes never throw across boundaries (repo convention).

---

## 7. Expired-link & re-registration recovery (the carried fix)

**The bug (flag off or on):** after registration the record sits `pending` with a disabled KC user. If the approval link **expires**, the confirm page says "ask the applicant to resubmit" — but resubmitting hits the uniqueness check (`409 USER_EXISTS`/`PHONE_EXISTS`). Dead end.

**Fix — make a `pending` record reclaimable.** The uniqueness check distinguishes by **status**:

- Match against an **`active`** record → keep returning `409` (genuine duplicate).
- Match against a **`pending`/`rejected`** record → **refresh**: update submitted details, **re-mint a fresh approval token, re-send the approval email**, reuse the existing (still-disabled) KC user. Both kinds:
  - **Coordinator:** the existing `pending` `aggregators` row is refreshed; new token to the org owner.
  - **Org:** the existing `pending` `aggregator_orgs` row is refreshed; new token to the network admin.

**Plus (recommended):** a periodic cleanup pruning records still `pending` past token expiry + grace — delete the pending `aggregators` row / `aggregator_orgs` row + mirrored KC group + disabled KC user — so the namespace stays clean even without a resubmit.

**Also:** a lightweight **"resend approval link"** path (admin/owner-triggered, or auto on hitting an expired link) that re-mints + re-emails for an existing `pending` record without re-entering the form.

This is the only robustness behaviour carried from `agg-registration-v2`; it is **independent of the hierarchy and ships standalone** (it fixes the flat flow too).

---

## 8. Provisioning steps (per kind)

No FSM/reconciler/dead-letter. Approval runs an **ordered, idempotent sequence** in the decision handler; the admin/owner can safely re-click (each step idempotent, single-use guarded by the atomic status CAS).

| Step                           | org | coordinator | Notes                                                                                                             |
| ------------------------------ | --- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| create row                     | ✅  | ✅          | **at submit**: org → `aggregator_orgs` `pending`; coordinator → `aggregators` `pending` (with `parent_org_id`)    |
| create KC group (mirror)       | ✅  | —           | **at submit**: mirrored group; store `kc_group_id` on the org row                                                 |
| owner/user KC create           | ✅  | ✅          | **at submit**: disabled KC user (org owner / coordinator), `decision_made=pending`                                |
| re-validate org active         | —   | ✅          | on approve, hard-gate (`TARGET_ORG_INACTIVE` if not)                                                              |
| signalstack upsert             | —   | ✅          | on approve, hard-gate. `domains` = coordinator's `type` (status-quo logic)                                        |
| KC enable                      | ✅  | ✅          | on approve, hard-gate — unblocks login (org owner enabled for future console; see §9 / A8)                        |
| stamp ids / decision           | —   | ✅          | soft-fail: `signalstack_org_id`, `decision_made=approved` — failure logged, repaired on re-click / login backfill |
| **status commit (atomic CAS)** | ✅  | ✅          | the "decided" write: `UPDATE … SET status='active' WHERE id=:id AND status='pending'` (org row / coordinator row) |
| welcome email                  | ✅  | ✅          | non-blocking                                                                                                      |

> **Removed vs v1:** the "add coordinator to org KC group" step (A1). The org→coordinator relationship is `parent_org_id`, written once at submit; there is no membership to keep in sync.

Hard-gated steps abort the approval on failure (record stays `pending`, link still works → re-click). Soft-fail steps log and continue; they self-heal on the next click or at login.

---

## 9. Auth, session, roles

- **Roles:** `org_owner`, `coordinator` (Keycloak realm/client roles).
- **KC group:** one mirrored group per org, holding the org owner (authz mirror). **Coordinators are not group members in v1** (A1) — membership is backfilled from `parent_org_id` if/when the org console needs KC-native group authz.
- **Coordinator login:** OIDC code flow → token claims `aggregator_id` (the coordinator's own SS-org-backed aggregator) + `role=coordinator` → `session.aggregator_id` = that coordinator. Single org → no org switcher. (Flag off: identical to today.)
- **org_owner login:** **deferred** — no org console yet. The owner acts only via token email links. The org-owner KC user is created + enabled **only to avoid a later migration** (A8); `/admin/**` gateway policy stays service-auth + per-action JWT. Enabling org login later = org dashboard + the role-gated read in §10 + (optionally) backfilling KC group membership — **no data migration**.
- **Approval-token binding:** a coordinator approval JWT carries `sub = aggregator_id` **and** the **`parent_org_id`** it was minted for. The decision handler verifies the record's `parent_org_id` matches the token's claim, so an owner's link can only decide **their own** org's coordinators. (Network-admin org tokens carry no org claim.) _(v2: binds on `parent_org_id`, the single authority — A1.)_
- **IdP adapter:** extend the KC admin client with group ops (`createGroup`, set group attributes) and `assignRole`. (No `addToGroup` for coordinators in v1.)

---

## 10. Data scoping (now and future)

### Now — automatic per-coordinator isolation (unchanged, status quo)

Each coordinator has its **own** `aggregator_id` / signalstack org. Every handler scopes by `session.aggregator_id`; the dashboard reads signalstack scoped to the coordinator's org. So **Coordinator 1 sees only Coordinator 1's data**, etc. — **no new code, no attribution column.**

The "don't let an org id leak into `session.aggregator_id`" footgun is structurally impossible: an org has **no `aggregators` row** and its id is an `aggregator_orgs.id` (uuid), never an aggregator id.

### Future — org-level view (deferred)

When org login ships, an `org_owner` session resolves its `aggregator_orgs.id` from the token and runs a plain FK query — no KC calls, no migration:

```sql
SELECT * FROM aggregators WHERE parent_org_id = :org_id;   -- the org's coordinators
-- then union each coordinator's signalstack-org data
```

The relationship is a single FK column (the **only** authority — A1), so the org-view is a one-column filter; no membership reconciliation needed.

---

## 11. Out of scope / deferred

- **PII encryption at rest** — separate work.
- **Org-level data view + org console login** — future; supported via `parent_org_id`, not built now.
- **Multi-org coordinator** — single org now (§12).
- **Coordinator KC group membership** — not in v1; backfilled from `parent_org_id` when the org console needs it (A1).
- **Invite-based coordinator onboarding** — future successor to self-register (§12 / A6).
- **Signalstack schema changes** — none.
- **Migrating existing aggregators under orgs** — not forced (§12).
- **`agg-registration-v2` engine** — explicitly NOT adopted; only the §7 recovery is carried.

---

## 12. Open items (defaults chosen; revisit if needed)

1. **Multi-org coordinator.** Default: **single org now** → `parent_org_id` is one nullable FK. Multiple orgs later = a `coordinator_org_memberships(aggregator_id, org_id, role)` table + an org switcher at login. Deferred.
2. **Existing aggregators.** Default: with the flag on, they are flat coordinators with `parent_org_id = null` (orphans); they keep working untouched and an org can "claim" them later. With the flag off, nothing changes.
3. **Org owner who also onboards.** Deferred. v2 returns `OWNER_ALREADY_REGISTERED` (A4) instead of a raw 409. Correct full implementation when built: grant the existing owner KC user the `coordinator` role and graduate an `aggregators` row + signalstack org (one identity, two roles).
4. **Self-registration abuse surface.** v2 **includes** per-IP / per-email rate limiting + per-(org,email) dedupe (A6). The planned successor is **invite-based** onboarding (owner invites → applicant completes via token; no public org dropdown for coordinators), which closes the unsolicited-email surface — deferred.
5. **Stale pending cleanup cadence.** §7 cleanup interval/grace — pick a value (e.g. token-TTL + 24h) when implementing.

---

## 13. Migration & rollout

Additive and small.

1. **Migration (additive):**
   - create table `aggregator_orgs` (§5.1), including the partial unique index on `slug` and the `status` / `owner_email` indexes;
   - add `aggregators.parent_org_id uuid NULL` with FK → `aggregator_orgs.id`.
     That's the only schema change. **No signalstack migration.**
2. **Flag default off:** ship `ORG_HIERARCHY_ENABLED=false` everywhere first. With the flag off, the new table is empty and the new column is unused → behaviour identical to today; safe to deploy to every instance immediately.
3. **The §7 recovery fix ships independently of the flag** (it fixes the flat flow too) — deploy it first/standalone.
4. **Enable per instance:** flip `ORG_HIERARCHY_ENABLED=true` only on instances that want the hierarchy, then admin-approve the first org (bootstrap) before coordinators can register.
5. **Rollback:** turning the flag off reverts to flat behaviour; the table/column stay inert. KC groups + `aggregator_orgs` rows created while on become harmless orphans. No schema drop needed.

No forced re-parenting of existing aggregators.

---

## 14. Testing

Delta tests over the current flow:

- **Flag off = no change** — registration/approval behave exactly as today; no org tab/dropdown; `parent_org_id` stays null; existing aggregator tests still pass; `aggregator_orgs` untouched.
- **Flag on, org flow** — submit inserts a `pending` `aggregator_orgs` row + mirrored KC group + disabled owner; admin approve flips `status='active'` via atomic CAS + enables owner; **no signalstack org**.
- **Org single-use guard (A3)** — a double-clicked approve link commits once (rows-affected guard); second click no-ops.
- **Flag on, coordinator flow** — submit inserts a `pending` `aggregators` row with `parent_org_id` (FK) + `type`; org-owner approve runs the status-quo sequence; **no KC group membership step** (A1).
- **Single source of truth (A1)** — after coordinator approval, `parent_org_id` is set and the coordinator is **not** a KC group member; the §10 org-view query returns the coordinator purely from `parent_org_id`.
- **Expired-link recovery (§7)** — resubmit (or resend) against a `pending` record refreshes it + re-mints a fresh token instead of `409`; against an `active` record still returns `409`.
- **Approver routing** — org → network admin; coordinator → target org's `owner_email` (read via SQL — A5).
- **Token binding (A1)** — a coordinator token minted for org A cannot approve a coordinator whose `parent_org_id` is org B.
- **Org inactive at approval** — target org `rejected`/retired after submit → coordinator approval declines with `TARGET_ORG_INACTIVE`.
- **Uniqueness vs active** — a coordinator submit with an existing **coordinator's** active email is rejected (`409`); with an existing **org owner's** email returns `OWNER_ALREADY_REGISTERED` (A4).
- **Slug collision (A9)** — a new org slug colliding with a non-terminal row returns `ORG_SLUG_TAKEN`; a slug matching only a `rejected` row succeeds.
- **Rate limiting (A6)** — repeated coordinator submits from the same IP/email are throttled; per-(org,email) repeats refresh rather than re-notify the owner.
- **Bootstrap** — coordinator submit when no org is `status='active'` is rejected; first org must be admin-approved first.
- **Stale cleanup** — a `pending` record past expiry+grace is pruned (row + mirrored group + disabled KC user).
- **Per-coordinator isolation** — coordinator 1 cannot read coordinator 2's data; `session.aggregator_id` scoping holds with `parent_org_id` set.
