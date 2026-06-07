# Design: User-Level Metrics + Directional Action Columns

**Date:** 2026-06-07
**Status:** Approved (brainstorm) — pending spec review
**Repos touched:** `Signals-DPG` (signalstack, upstream) → then `aggregator-dpg` (this repo)

---

## Problem

The aggregator dashboard today shows **profile-level data only**. Two gaps:

1. **A user can have multiple profiles.** The dashboard has no user-level view — it
   cannot answer "how many unique participants do I have" or "average profiles per
   user", because every metric counts profiles, not users.
2. **Actions are combined.** Each profile's action counts (`create / accept / reject /
cancel`) are surfaced as one blended set. Whether the profile **initiated** an action
   or **received** it is lost. The aggregator needs them as two separate column groups.

This document is dot-agnostic. The reference JTBD doc is written for Blue Dots, but the
aggregator runs against any network (blue/purple/orange/…). Therefore **no metric name,
label, or bucket is hardcoded** — everything new is config-driven from `network.json`,
exactly like the existing `dashboard_tiles` / `dashboard_buckets` / `status_rules`.

## Decisions locked in brainstorming

- **ALL compute lives in signalstack** — the aggregator does **zero** grouping or
  aggregation. User-level totals must span the full dataset; the aggregator only ever holds
  a paginated 100-row page. Signalstack already precomputes the rollup
  (`avg_items_per_user`, `avg_actions_per_user`), so user-level numbers fold into the same
  code path. Aggregator stays display-only, matching the documented Signal Processing
  Service architecture ("no computation happens within the Aggregator platform").
- **No `user_id` grouping in the aggregator.** Because signalstack owns user-level compute
  and the table stays profile-level, the aggregator never groups by `user_id`. Items carry
  **`profile_item_id` (required — the per-row key)** and **`user_id` (optional — traceability
  / future profile→user drill-in only)**. `profile_item_id` is required because the table is
  profile-level: a user with N profiles is N rows, so `user_id` is not unique per row and
  cannot serve as the React key.
- **Hard cutover on action fields.** Flat `count_*` is replaced by `initiated` / `received`
  maps. No back-compat alias. Signalstack and aggregator ship together.
- **Direction comes from signalstack** (action role), never inferred by the aggregator.
- **Dashboard is two sections:**
  - **Top (summary):** profile-level tiles (exist today) **+** user-level tiles (new). Both
    groups defined in `network.json`.
  - **Bottom (table):** one row per profile (unchanged grouping). Only change: the combined
    action cell splits into **Initiated** and **Received** column groups.
- **Implementation order:** signalstack first (produces enhanced payload), then aggregator
  reads it.

---

# Section 1 — Signalstack changes (upstream, `Signals-DPG`)

Signalstack owns all computation. Three additions to the
`GET /api/v1/aggregator/dashboard` payload.

## 1.1 `profile_item_id` (required) + `user_id` (optional) on every profile item

Each item in `by_domain[<id>].items[]` gains:

| Field             | Type   | Required | Purpose                                                                           |
| ----------------- | ------ | -------- | --------------------------------------------------------------------------------- |
| `profile_item_id` | string | yes      | stable per-row key for the profile table (`user_id` repeats across a user's rows) |
| `user_id`         | string | no       | traceability / future profile→user drill-in. NOT used for any aggregator compute  |

The aggregator does **no** grouping by `user_id` — all user-level numbers come precomputed
in the rollup (§1.3). `profile_item_id` exists purely as the row identity; `user_id` is an
optional passthrough. Both are already known at profile-create time (signalstack returns
them from the onboard call); this exposes them on the read path.

## 1.2 Directional action maps (replace flat `count_*`)

**Remove** (hard cutover): `count_create`, `count_accept`, `count_reject`, `count_cancel`,
`last_create_at`, `last_accept_at`, `last_reject_at`, `last_cancel_at`.

**Add** per item:

```jsonc
"initiated":        { "create": 1, "accept": 0, "reject": 0, "cancel": 0 },
"received":         { "create": 0, "accept": 1, "reject": 0, "cancel": 0 },
"last_initiated_at": { "create": "2026-01-01T00:00:00Z", "accept": null, "reject": null, "cancel": null },
"last_received_at":  { "create": null, "accept": "2026-01-02T00:00:00Z", "reject": null, "cancel": null }
```

Direction is assigned by signalstack from the action's role relative to the profile.

## 1.3 Rollup gains directional + user-level numbers

Replace `by_action_status` with two directional maps, and add user-level counts:

```jsonc
"rollup": {
  // profile-level (existing)
  "total_items": 5,
  "complete_profiles": 2,
  "has_applications": 3,
  "by_status": { "new": 1, "active": 3, "at_risk": 0, "inactive": 1 },

  // directional (replaces by_action_status)
  "by_initiated_action_status": { "create": 4, "accept": 0, "reject": 0, "cancel": 0 },
  "by_received_action_status":  { "create": 0, "accept": 5, "reject": 1, "cancel": 0 },

  // user-level (NEW — computed over the full dataset)
  "total_users": 4,
  "users_with_applications": 3,
  "new_users_7d": 1,
  "avg_items_per_user": 1.25,      // already present
  "avg_actions_per_user": 3.3,     // already present

  "mode_wise_counts": { "link": 5 }
}
```

## 1.4 Full enriched item — example response

```jsonc
{
  "by_domain": {
    "seeker": {
      "rollup": {
        "total_items": 5,
        "complete_profiles": 2,
        "has_applications": 3,
        "by_status": { "new": 1, "active": 3, "at_risk": 0, "inactive": 1 },
        "by_initiated_action_status": { "create": 4, "accept": 0, "reject": 0, "cancel": 0 },
        "by_received_action_status": { "create": 0, "accept": 5, "reject": 1, "cancel": 0 },
        "total_users": 4,
        "users_with_applications": 3,
        "new_users_7d": 1,
        "avg_items_per_user": 1.25,
        "avg_actions_per_user": 3.3,
        "mode_wise_counts": { "link": 5 },
      },
      "items": [
        {
          "user_id": "u-123",
          "profile_item_id": "p-abc",
          "name": "Asha",
          "item_network": "purple_dot",
          "item_domain": "seeker",
          "item_type": "profile_1.0",
          "onboarded_via": "link",
          "profile_status": "active",
          "profile_completion_pct": 80,
          "profile_created_at": "2026-01-01T00:00:00Z",
          "profile_last_updated_at": "2026-01-02T00:00:00Z",
          "age_days": 5,
          "initiated": { "create": 1, "accept": 0, "reject": 0, "cancel": 0 },
          "received": { "create": 0, "accept": 1, "reject": 0, "cancel": 0 },
          "last_initiated_at": {
            "create": "2026-01-01T00:00:00Z",
            "accept": null,
            "reject": null,
            "cancel": null,
          },
          "last_received_at": {
            "create": null,
            "accept": "2026-01-02T00:00:00Z",
            "reject": null,
            "cancel": null,
          },
          "actionable_tags": [],
        },
      ],
      "total_matching": 5,
      "next_cursor": null,
    },
  },
  "metadata": {
    "last_computed_at": "2026-01-01T00:00:00Z",
    "ttl_seconds": 3600,
    "refreshed": false,
  },
}
```

---

# Section 2 — Aggregator-DPG changes (this repo, reads the enhanced payload)

The aggregator validates and renders the new fields. **No new computation** — it only
reshapes for display and reads labels/aggregation hints from `network.json`.

## 2.1 Contracts — `packages/signalstack-writer/src/interface.ts`

Update `SignalStackDashboardRollup` and the item shape:

- Rollup: drop `by_action_status`; add `by_initiated_action_status`,
  `by_received_action_status`, `total_users`, `users_with_applications`, `new_users_7d`.
  Keep `avg_items_per_user`, `avg_actions_per_user`.
- Item: add `profile_item_id` (required), `user_id` (optional), `initiated`, `received`,
  `last_initiated_at`, `last_received_at`; drop flat `count_*` / `last_*_at`.
- Mirror in `apps/web/src/services/dashboard.service.ts` `DashboardRollup`.
- `toSeekerRow` / `toProviderRow` (`dashboard/page.tsx`) currently use `user_id` as the row
  `id`; switch the row `id`/React key to `profile_item_id` (one row per profile — `user_id`
  is not unique per row). `user_id` becomes an optional passthrough, not the key.

Both directional maps stay `Partial<Record<'create'|'accept'|'reject'|'cancel', number>>`
to match the existing defensive `?? 0` reads.

## 2.2 Config — `network.json` (consumed via `packages/network-config`)

Extend the per-domain / network passthrough types in
`packages/network-config/src/interface.ts`. **All optional; UI falls back to English.**

**(a) Tile definitions — profile-level + user-level groups.** Today `DashboardTileLabels`
is a flat label map. Replace with a structure that declares which tiles render, their
label, their source field, and (for user tiles) the metric level:

```jsonc
"dashboard_tiles": {
  "profile": [
    { "field": "total_items",       "label": "Profiles Registered" },
    { "field": "complete_profiles", "label": "Complete Profiles" },
    { "field": "has_applications",  "label": "Profiles with Applications" }
  ],
  "user": [
    { "field": "total_users",             "label": "Total Seekers" },
    { "field": "avg_items_per_user",       "label": "Avg Profiles per Seeker" },
    { "field": "users_with_applications",  "label": "Seekers with Applications" },
    { "field": "new_users_7d",             "label": "New Seekers (7d)" }
  ]
}
```

`field` maps to a rollup key. The aggregator does **not** compute — it reads the precomputed
rollup value by key. Aggregation (sum/avg/distinct) already happened in signalstack; the
config only picks which fields to show and what to call them. Unknown `field` → tile skipped
(logged at `warn`).

**(b) Directional bucket labels.** Extend `DashboardBuckets`:

```jsonc
"dashboard_buckets": {
  "by_status": { "at_risk": "At Risk" },
  "by_initiated_action_status": { "create": "Applied", "accept": "Accepted", "reject": "Rejected", "cancel": "Withdrawn" },
  "by_received_action_status":  { "create": "Requests", "accept": "Shortlisted", "reject": "Rejected", "cancel": "Cancelled" }
}
```

Old `by_action_status` key is removed.

## 2.3 API passthrough — `apps/api/src/routes/dashboard.ts`

Proxy is field-agnostic today (forwards the signalstack payload). Verify no field is
dropped/whitelisted; update any Zod response validation to the new shape. CSV export
columns are owned by signalstack — update the column expectations in
`apps/api/src/routes/dashboard.test.ts` to match the new headers.

## 2.4 Top summary — `apps/web/src/app/(protected)/dashboard/page.tsx`

- Render **two tile groups** from `cfg…dashboard_tiles.profile` and `.user`, each a list of
  `MiniStat`/`StatCard` driven by config (label + rollup field). No hardcoded metric names.
- Existing `StatCard` status cards (by_status) unchanged.

## 2.5 Bottom table — same file

- Replace the single combined action/funnel cell with **two column groups**: **Initiated**
  and **Received**. Each renders its buckets from `initiated` / `received`, labelled from
  `dashboard_buckets.by_initiated_action_status` / `by_received_action_status`.
- All other columns (name, joined, profile status, status pill, recommended action)
  unchanged. Table stays **one row per profile** (no user grouping in the table).

## 2.6 Config files to update

Add the new `dashboard_tiles` / `dashboard_buckets` blocks to the relevant
`network.json` files for blue/purple/orange dots (upstream of the aggregator). Where a dot
omits them, the aggregator falls back to generic English labels.

---

## Edge cases

| Case                                     | Behaviour                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Item missing `profile_item_id`           | row falls back to a synthetic key (array index); logged `warn`. Should not happen — required upstream.                                    |
| Item missing `user_id`                   | fine — optional, used only for traceability/drill-in. No grouping depends on it. User-level rollup is signalstack-computed so unaffected. |
| Rollup missing a user-level field        | tile shows `0` / skipped; logged `warn` with `operation`, `status: 'skipped'`.                                                            |
| `dashboard_tiles` absent in network.json | fall back to default English profile tiles; user group hidden.                                                                            |
| Direction maps absent / empty            | columns render zeros, never throw (defensive `?? 0`).                                                                                     |
| Unknown `field` in tile config           | tile skipped, `warn` logged.                                                                                                              |

## Testing

- `signalstack-writer`: update `memory.ts` fake + `http.test.ts` / `memory.test.ts`
  fixtures to the enriched shape (drop `count_*`, add directional + `user_id`). Update
  `ServiceFake` `seed()` / builders.
- `network-config`: tests for the new `dashboard_tiles` {profile,user} + directional bucket
  parsing, including absent/partial config fallback.
- `apps/api/dashboard.test.ts`: new payload shape + CSV header expectations.
- `apps/web`: dashboard service mapping tests for directional buckets + user-level tiles;
  component test that two tile groups + two action column groups render from config.
- Target ≥ 70% line coverage per package.

## Out of scope (YAGNI)

- User-grouped rows in the table (kept profile-level by decision).
- Aggregator-side recomputation / paging-all-rows.
- Shortlisted-as-distinct-bucket beyond what `accept`/`reject` already encode (revisit if
  signalstack adds a dedicated shortlist state).
- Provider-specific status logic (Satisfied/openings) — separate effort.

## Build order

1. **Signalstack** (`Signals-DPG`): §1.1–1.3, ship enriched payload + update network.json.
2. **Aggregator** (`aggregator-dpg`): §2.1 contracts → §2.2 config types → §2.3 API → §2.4/2.5 UI → §2.6 config files → tests.
