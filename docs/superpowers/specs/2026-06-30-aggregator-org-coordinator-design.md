# Aggregator Org + Coordinator Design

> **⚠️ SUPERSEDED (2026-06-30) by [`2026-06-30-aggregator-org-coordinator-design-v2.md`](./2026-06-30-aggregator-org-coordinator-design-v2.md).**
> v2 incorporates review findings: a thin `aggregator_orgs` DB table as the org system-of-record (KC group demoted to an authz mirror), `aggregators.parent_org_id` (FK) as the **single** source of truth for the org→coordinator link (coordinator KC-group membership dropped from v1), an atomic status CAS for the approval single-use guard, SQL-based org dropdown/owner lookup, coordinator-submit rate limiting, and clearer error/terminology handling. This v1 is retained for history; **build from v2.**

**Audience:** Product team and developers extending the aggregator registration subsystem to support a parent **organisation** that owns multiple **coordinators**.

**Status:** Superseded by v2 (see banner above). Original status: Design (approved for spec; implementation plan to follow).

**Relationship to existing work:** This design extends the **current production aggregator registration flow** (DB `aggregators` row + Keycloak user + signalstack org, signed-token approval, status `pending → active`/`inactive`). It does **not** depend on the `agg-registration-v2` engine — none of that engine's machinery (FSM, reconciler, dead-letter, dedup fingerprint, OpenTelemetry framework, `registrations` table) is used. The one robustness improvement we carry is the **expired-link / re-registration recovery** fix (§7).

---

## Contents

1. [Goal](#1-goal)
2. [Feature flag — org hierarchy on/off per instance](#2-feature-flag--org-hierarchy-onoff-per-instance)
3. [Key reframe](#3-key-reframe)
4. [Identity layers](#4-identity-layers)
5. [Data model](#5-data-model)
6. [Registration + approval flows](#6-registration--approval-flows)
7. [Expired-link & re-registration recovery (the fix)](#7-expired-link--re-registration-recovery-the-fix)
8. [Provisioning steps (per kind)](#8-provisioning-steps-per-kind)
9. [Auth, session, roles](#9-auth-session-roles)
10. [Data scoping (now and future)](#10-data-scoping-now-and-future)
11. [Out of scope / deferred](#11-out-of-scope--deferred)
12. [Open items](#12-open-items)
13. [Migration & rollout](#13-migration--rollout)
14. [Testing](#14-testing)

---

## 1. Goal

Let a **parent organisation** (e.g. "Enable India") register once, then have multiple **coordinators** (ground-team members) register under it. Each coordinator onboards participants (seekers/providers) and — for now — sees **only the data they onboarded**. Org-level visibility (an org owner seeing all its coordinators' data) is a **future** capability the model must not preclude.

Constraints that shaped the design:

- Minimise change. Today's aggregators already work; do not rework them. Build on the current flow, not the `agg-registration-v2` engine.
- Do not change the signalstack schema.
- Preserve the `session.aggregator_id` scoping invariant (it is the core security boundary).
- **The hierarchy is optional per instance** — some instances want org→coordinator, some want today's flat aggregator. A flag decides (§2).

---

## 2. Feature flag — org hierarchy on/off per instance

The whole org/coordinator layer is gated by a single startup flag, since some instances want it and some don't.

- **Flag:** `ORG_HIERARCHY_ENABLED` (boolean env var, in `packages/config` / `config.ts`, **default `false`**). It is read **per running instance** from that instance's environment, so each deployment decides independently — two instances of the same network can differ. Read once at startup (configuration-discipline rule); flipping it needs a restart.

- **OFF (default) — today's behaviour, unchanged:**
  - Single flat registration form → one `aggregators` row → **network-admin** approval → active. No org tab, no org dropdown, no Keycloak groups, no coordinator concept. `parent_kc_group_id` stays `null`.
  - 100% backward compatible: existing instances that don't set the flag see zero behavioural change.

- **ON:**
  - Two registration entry points (Org tab + Coordinator tab), org dropdown, org-owner approval routing, Keycloak groups, `coordinator.parent_kc_group_id` populated.

The new schema (§5) is **additive and inert when the flag is off** — the columns exist everywhere but are only written/read when `ORG_HIERARCHY_ENABLED=true`. Everything in §3–§10 below describes the **flag-ON** behaviour; flag-OFF is just "the current flow as-is".

---

## 3. Key reframe

**Today's "aggregator" = "coordinator".** An aggregator is an entity that gets its own signalstack organisation, can log in, and onboards participants. That is exactly what a coordinator is. So the existing registration flow _is_ the coordinator flow; we reuse it and add a lighter parent-org concept above it (when the flag is on).

**Type (seeker/provider) lives on the coordinator, not the org.** Today's aggregator is registered as a **seeker-aggregator or provider-aggregator** — `aggregators.type` + `actor_type`, mirrored to the KC `aggregator_type` attribute, with single-type enforcement. The coordinator keeps that **unchanged** (status quo). What's new is only that the **org has no type** — an org spans both, so coordinators of different types can sit under one org. (The participant's own `item_domain` in signalstack is a separate, item-level field and is unaffected.)

---

## 4. Identity layers

| Layer             | What it is                                                                                                         | Signalstack org?                                  | Logs in?              | Approved by     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------- | --------------- |
| **Network admin** | Platform operator (existing)                                                                                       | —                                                 | No (token links only) | —               |
| **Parent org**    | Keycloak **group** (+ org-owner KC user) — **no database row**; org metadata lives as group attributes             | **No**                                            | Not yet (deferred)    | Network admin   |
| **Coordinator**   | Keycloak user (`coordinator` role) in the org's group; **= an `aggregators` row** with its **own** signalstack org | **Yes** (status quo)                              | Yes                   | The org's owner |
| **Participant**   | Signalstack `user` account + item (`created_by = account`)                                                         | Lives **under the coordinator's** signalstack org | n/a                   | n/a             |

A participant account is attributed to the coordinator's signalstack org via the existing `user.onboarded_by_org_id`. No new attribution field is required (see §10).

When the flag is OFF, only "Network admin" and a flat "aggregator" (= the Coordinator row, no parent) exist.

---

## 5. Data model

### Parent org — **Keycloak group only, no database table**

There is **no `aggregator_orgs` table** and **no `registrations` table** (the current flow has neither). The org is a Keycloak **group**; its identity is the group id. The group is created at **submit** with `status=pending` (it doubles as the pending-registration store) and flipped to `active` on approval. All org metadata is carried as **group attributes**:

| Group attribute     | Description                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| group `name`/`path` | The org's slug (KC enforces group-name uniqueness under the parent → free slug uniqueness). Display name also stored as an attribute.          |
| `display_name`      | Org display name                                                                                                                               |
| `owner_email`       | Org owner contact — coordinator approval emails are routed here                                                                                |
| `owner_kc_sub`      | Keycloak user id of the org owner                                                                                                              |
| `status`            | `pending` (created at submit) \| `active` (admin approved) \| `rejected` (admin declined). The org dropdown filters groups on `status=active`. |

**Why KC-only is acceptable here:** an org is a pure grouping — it has no signalstack org and no data-scoping role, so it never needs to be queried/joined/constrained the way a coordinator does. The group is the org's record across its whole lifecycle (pending → active). The "don't let an org id leak into `session.aggregator_id`" footgun is structurally impossible: an org has no `aggregators` row and its id is a KC group id, never an aggregator id.

**Trade-off accepted:** the org dropdown and `owner_email` lookups read the **KC admin API** (list groups by `status=active`, read group attributes), not SQL. Org count is small and cacheable, so this is fine; just note it is a KC call, not a DB query. Pending/rejected orgs live as KC groups (not in a DB table) — a periodic cleanup may prune long-stale `pending`/`rejected` groups (§7).

### `aggregators` (existing = coordinator) — additions

| Column               | Type      | Description                                                                                                                                                                                                                    |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parent_kc_group_id` | text null | The Keycloak **group id** of the org this coordinator belongs to (not a DB FK — orgs have no table). Set at **submit** from the chosen org. `null` = flat aggregator (flag off) or legacy. Only populated when the flag is on. |

Plain text id (the KC group), nullable, **no FK** — the org has no DB row to reference. A coordinator joins **one** org for now (see §12). Everything else on `aggregators` is unchanged; coordinators keep their own `type`, `actor_type`, and `signalstackOrgId`. The pending coordinator **is** the `aggregators` row with `status=pending` (status quo) — no separate registration record.

**When the flag is on, org selection is mandatory for new coordinators.** **Bootstrap order:** the first org must be admin-approved (its KC group `status=active`) before any coordinator can register — the coordinator form's org dropdown (KC groups where `status=active`) is empty until then.

### Signalstack

**No schema change.** Coordinator = own signalstack org (status quo). Participant accounts carry `onboarded_by_org_id` (the coordinator's signalstack org) as today.

---

## 6. Registration + approval flows

Both flows use the **current** signed-token, no-login approval mechanism (mint approve/reject JWTs → email → HTML confirm page → decision POST → single-use guard via stored status). Only the store, approver, and provisioning differ. (All of this section is flag-ON behaviour.)

### Org (`kind='org'` — selected by hitting the org endpoint)

```
Applicant (org)                 API                          Network admin
1. Submit org form ───► create KC group status=pending
                        + org-owner KC user (disabled)
                        verification email ─────────────────► applicant
2. Verify email   ───► (owner email verified)
                        admin notification (token link) ────► NETWORK ADMIN
3. Approve (token) ───► flip group status=active
                        enable owner KC user + org_owner role
                        add owner to the group
                        welcome email
```

The KC group **is** the org across its lifecycle — created `pending` at submit, flipped `active` on approval. No DB row, no signalstack org. Console login for the owner is **deferred** — the owner acts only via token links for now. Reject → group `status=rejected`, owner stays disabled.

### Coordinator (`kind='coordinator'` — the current aggregator flow + org link)

```
Applicant (coordinator)         API                          Org owner
1. Submit form + select org ──► create aggregators row status=pending
                                  (parent_kc_group_id = chosen group, type = seeker/provider)
                                + KC user (disabled, decision_made=pending)
                                verification email ──────────► applicant
2. Verify email          ────► verified
                                approval token ──────────────► THE ORG'S OWNER (group owner_email)
3. Approve (token)       ────► signalstack upsert (own org, domains = type)   [hard-gate]
                                enable KC user                                [hard-gate]
                                decision_made = approved                      [soft-fail]
                                stamp signalstack_org_id (KC + DB)            [soft-fail]
                                add to org KC group                           [soft-fail→repair]
                                status = active                               [commit = decided]
                                welcome email
```

This is exactly today's approve sequence (hard-gated signalstack + KC enable, soft-fail attribute writes, status flip as the atomic "decided" commit) **plus** joining the org KC group. The coordinator's submit form gains an org selector listing **KC groups with `status=active`** (KC admin API). The approval JWT is minted to the **org owner's** `owner_email` (read from the target group), not the network admin.

**Re-validate the org at approval (not just submit).** A group can be rejected/retired between submit and approval. Before provisioning, re-read the target group and confirm `status=active`; if not (or gone), decline with `TARGET_ORG_INACTIVE` and notify the applicant — provisioning never runs against a dead org.

**Reject path.** Either approver can decline (`intent=reject`): network admin for org, org owner for coordinator. A decline sets the org group `status=rejected` (org) or the coordinator's `status=inactive` (coordinator) and emails the applicant. No KC user is enabled and no signalstack org is created.

---

## 7. Expired-link & re-registration recovery (the fix)

**The bug today (flag off or on):** after registration, the record sits `pending` with a disabled KC user. If the approval link **expires**, the confirm page says _"This approval link has expired. Ask the applicant to resubmit."_ — but resubmitting hits the uniqueness check (email/phone already exist in DB + KC) and returns **`409 USER_EXISTS` / `PHONE_EXISTS`**. The applicant is told to resubmit, yet resubmission is impossible. Dead end.

**Fix — make a `pending` record reclaimable.** The uniqueness check distinguishes by **status**:

- Email/phone matches a record that is **`active`** (truly onboarded) → keep returning `409` (genuine duplicate).
- Email/phone matches a record that is **`pending`** (or `rejected`) → **not a conflict**: treat the new submit as a **refresh** of that pending record — update the submitted details, **re-mint a fresh approval token, re-send the approval email**, and reuse the existing KC user (still disabled) instead of failing. Applies to both kinds:
  - **Coordinator:** the existing `pending` `aggregators` row is refreshed; new token to the org owner.
  - **Org:** the existing `pending` KC group is refreshed; new token to the network admin.

**Plus (optional, recommended):** a periodic cleanup that prunes records still `pending` well past token expiry (e.g. expiry + grace) — delete the pending `aggregators` row / KC group + disabled KC user — so the namespace stays clean even without a resubmit.

**Also:** add a lightweight **"resend approval link"** path (admin/owner-triggered, or auto on hitting an expired link) that re-mints + re-emails for an existing `pending` record without requiring the applicant to re-enter the form.

This is the only robustness behaviour carried over; it is independent of the org/coordinator hierarchy and applies to the flat flow too.

---

## 8. Provisioning steps (per kind)

There is no FSM/reconciler/dead-letter. Approval runs an **ordered, idempotent sequence** in the decision handler; the admin/owner can safely re-click the link (each step is idempotent, single-use is guarded by the stored `status`).

| Step                  | org | coordinator | Notes                                                                                                           |
| --------------------- | --- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| create row/group      | ✅  | ✅          | **at submit**: org → KC group `pending`; coordinator → `aggregators` row `pending`                              |
| owner/user KC create  | ✅  | ✅          | **at submit**: disabled KC user (org owner / coordinator), `decision_made=pending`                              |
| signalstack upsert    | —   | ✅          | on approve, hard-gate. `domains` = coordinator's `type` (status-quo upsert logic)                               |
| KC enable             | ✅  | ✅          | on approve, hard-gate — unblocks login                                                                          |
| group create/activate | ✅  | —           | on approve, flip group `status=active`; add owner to group                                                      |
| add to org group      | —   | ✅          | on approve — join the org's KC group (membership). Idempotent (no-op if already a member)                       |
| stamp ids / decision  | ✅  | ✅          | soft-fail: `signalstack_org_id`, `decision_made=approved` — failure logged, repaired on re-click/login backfill |
| status commit         | ✅  | ✅          | the atomic "decided" write: org group `status=active`; coordinator `aggregators.status=active`                  |
| welcome email         | ✅  | ✅          | non-blocking                                                                                                    |

Hard-gated steps abort the approval on failure (record stays `pending`, link still works → re-click). Soft-fail steps log and continue; they self-heal on the next click or at login.

---

## 9. Auth, session, roles

- **Roles:** `org_owner`, `coordinator` (Keycloak realm/client roles).
- **Group:** one Keycloak **group per org**; members are the org owner and its coordinators.
- **Coordinator login:** OIDC code flow → token claims `aggregator_id` (the coordinator's own SS-org-backed aggregator) + `role=coordinator` → `session.aggregator_id` = that coordinator. With single-org membership there is no org switcher. (Flag off: identical to today's aggregator login.)
- **org_owner login:** deferred — no org console yet. The owner acts only via token email links (approving coordinators); the `/admin/**` gateway policy stays service-auth + per-action JWT. Enabling org login later = adding the org dashboard + the role-gated read in §10, no data migration.
- **Approval-token binding:** a coordinator approval JWT carries `sub = aggregator_id` **and** the `parent_kc_group_id` it was minted for. The decision handler verifies the record's `parent_kc_group_id` matches the token's group claim, so an org owner's link can only decide **their own** org's coordinators. (Network-admin org tokens carry no group claim.)
- **IdP adapter:** extend the Keycloak admin client with group ops (`createGroup`, `addToGroup`, set group attributes) and `assignRole`.

---

## 10. Data scoping (now and future)

### Now — automatic per-coordinator isolation

Each coordinator has its **own** `aggregator_id` / signalstack org. Every handler already scopes by `session.aggregator_id`, and the dashboard reads signalstack scoped to the coordinator's org. So **Coordinator 1 sees only Coordinator 1's data, Coordinator 2 only theirs** — with **no new code or attribution column**. Status-quo behaviour, unchanged.

### Future — org-level view (deferred)

When org login ships, an `org_owner` session resolves its KC group id from the token and runs:

```sql
SELECT * FROM aggregators WHERE parent_kc_group_id = :group;   -- the org's coordinators
-- then union each coordinator's signalstack-org data
```

A plain filter on `parent_kc_group_id` → union of the child coordinators' signalstack orgs. The org list comes from KC; the coordinator membership it owns is a one-column query on `aggregators`. No migration, no new attribution field.

---

## 11. Out of scope / deferred

- **PII encryption at rest** — separate work.
- **Org-level data view + org console login** — future; supported via `parent_kc_group_id`, not built now.
- **Multi-org coordinator** — single org now (§12).
- **Signalstack schema changes** — none.
- **Migrating existing aggregators under orgs** — not forced (§12).
- **`agg-registration-v2` engine** — explicitly NOT adopted; only the §7 recovery behaviour is carried.

---

## 12. Open items (defaults chosen; revisit if needed)

1. **Multi-org coordinator.** Default: **single org now** → `parent_kc_group_id` is one nullable column. Multiple orgs later = a `coordinator_org_memberships(aggregator_id, kc_group_id, role)` table (and/or native KC group membership) + an org switcher at login. Deferred.
2. **Existing aggregators.** Default: with the flag on, they are flat coordinators with `parent_kc_group_id = null` (orphans). They keep working untouched; an org can "claim" them later. With the flag off, nothing changes.
3. **Org owner who also onboards.** An `org_owner` has no signalstack org, so cannot onboard. The naive "register again as a coordinator with the same email" **fails** the unique email/phone check. Correct approach when needed: grant the existing owner KC user the `coordinator` role and graduate an `aggregators` row + signalstack org for it (one identity, two roles). Deferred.
4. **Self-registration abuse surface.** Coordinator self-registration emails the org owner unsolicited. Add per-IP / per-email rate-limiting on submit; later let an owner block/report an applicant.
5. **Stale pending cleanup cadence.** §7 cleanup interval/grace — pick a value (e.g. token-TTL + 24h) when implementing.

---

## 13. Migration & rollout

Additive and small — **no `aggregator_orgs` table, no `registrations` table**.

1. **Migration (additive):** add `aggregators.parent_kc_group_id` (text, nullable). That's the only schema change.
2. **Flag default off:** ship `ORG_HIERARCHY_ENABLED=false` everywhere first. With the flag off the new column is unused and behaviour is identical to today, so the migration is safe to deploy to every instance immediately.
3. **The §7 recovery fix** ships independently of the flag (it fixes the flat flow too) — deploy it first/standalone.
4. **Enable per instance:** flip `ORG_HIERARCHY_ENABLED=true` only on instances that want the hierarchy, then admin-approve the first org (bootstrap) before coordinators can register.
5. **Rollback:** turning the flag off reverts to flat behaviour; the column stays inert. KC groups created while on become harmless orphans. No schema drop needed.

No signalstack migration. No forced re-parenting of existing aggregators.

---

## 14. Testing

Delta tests over the current flow:

- **Flag off = no change** — registration/approval behave exactly as today; no org tab, no dropdown, `parent_kc_group_id` stays null; existing aggregator tests still pass.
- **Flag on, org flow** — submit creates a `pending` KC group + disabled owner; admin approve flips group `status=active` + enables owner + adds owner to group; **no DB row, no signalstack org**.
- **Flag on, coordinator flow** — submit creates a `pending` `aggregators` row with `parent_kc_group_id` + `type`; org-owner approve runs the status-quo sequence **plus** group membership.
- **Expired-link recovery (§7)** — resubmit (or resend) against a `pending` record refreshes it + re-mints a fresh token instead of `409`; against an `active` record still returns `409`.
- **Approver routing** — org → network admin; coordinator → target group's `owner_email`.
- **Token binding** — a coordinator token for group A cannot approve a coordinator whose `parent_kc_group_id` is group B.
- **Org inactive at approval** — target group rejected/retired after submit → coordinator approval declines with `TARGET_ORG_INACTIVE`.
- **Uniqueness vs active** — a coordinator submit with an existing org owner's (active) email is rejected.
- **Bootstrap** — coordinator submit when no group is `status=active` is rejected; first org must be admin-approved first.
- **Stale cleanup** — a `pending` record past expiry+grace is pruned (row/group + disabled KC user).
- **Per-coordinator isolation** — coordinator 1 cannot read coordinator 2's data; `session.aggregator_id` scoping holds with `parent_kc_group_id` set.
