# Dashboard bulk select + extensible bulk actions

**Date:** 2026-06-10 · **Base:** `feat/dashboard-design-restructure` · **Branch:** `feat/dashboard-bulk-select`

## Goal

Let aggregator operators select participant rows in the dashboard table and run
bulk actions on the selection. Two actions ship now — export selected rows as
CSV (client-side) and trigger a callback (server stub) — but the action surface
is an open registry so future bulk actions are one descriptor away.

## Decisions (locked with user)

1. Selected-only CSV is generated **client-side** from the selected rows'
   table data. The existing full "Export CSV" (signalstack proxy) is untouched.
2. "Trigger callback" posts to a **new BFF endpoint stub** (`202`, structured
   log, no upstream call yet) so the contract is fixed before the real
   integration lands.
3. Selection **persists across pages** (cleared on status/lifecycle filter or
   tab change). The header checkbox selects/deselects the current page only.
4. Bulk actions are **decoupled from selection** via a `BulkAction` registry —
   the bar renders whatever descriptors it is given.

## Design

### Selection layer (`ParticipantTable`)

- New leading checkbox column. Row checkbox toggles membership in a
  `Map<string, ParticipantBase>` keyed by row id, storing a row **snapshot**
  (needed so CSV export can include rows from pages no longer mounted).
- Header checkbox: checked when every selectable row on the page is selected,
  indeterminate when some are, otherwise unchecked. Click = select/deselect
  current page.
- Rows whose id is synthetic (`row-<index>`, no `profile_item_id` upstream) are
  **not selectable** — synthetic keys collide across pages.
- Selection clears automatically when the status filter, lifecycle filter, or
  domain (tab) changes — the selection's meaning changed under it.

### Bulk action registry

```ts
interface BulkAction {
  id: string; // stable key, also the server-side action name
  labelKey: string; // dashboard.bulk.* i18n key
  icon: IconName;
  kind: 'client' | 'server';
  run(rows: ParticipantBase[], ctx: { domain: string }): Promise<void>;
}
```

- The bulk bar renders one button per descriptor, with per-action
  pending / transient-success / error state. It knows nothing about what the
  actions do.
- Adding a future bulk action = appending one descriptor (plus, for server
  actions, extending the endpoint allowlist).

### Action 1 — export selected CSV (`kind: 'client'`)

`buildParticipantCsv(rows)` pure util (new `services/participant-csv.ts`):
columns `id, name, joined, profile_completion_pct, lifecycle, status,
initiated_*, received_*`. RFC-4180 quoting (quotes doubled, fields with
comma/quote/newline wrapped). Download via existing `triggerCsvDownload`-style
blob anchor. Vitest unit tests: normal rows, empty selection, special
characters.

### Action 2 — trigger callback (`kind: 'server'`)

`POST /api/dashboard/actions` (web BFF route, same session guard pattern as
`/api/dashboard/export`):

```jsonc
{ "action": "trigger_callback", "domain": "seeker", "ids": ["..."] } // ≤ 500 ids
```

- Body zod-validated; `action` checked against a server-side allowlist
  (today: `trigger_callback`) so unknown actions 400 rather than silently 202.
- Stub behaviour: structured log (`operation`, `status`, count) and
  `202 { accepted: n }`. No upstream call yet.
- `dashboardService.dashboardBulkAction(...)` wraps the fetch.

### i18n

`dashboard.bulk.*` keys in en/hi/kn: selected count, clear, export-selected,
trigger-callback, success/error lines, checkbox arias.

## Out of scope

- Real callback delivery (endpoint stays a stub until the upstream service exists).
- Select-all-matching-server-side (selection is bounded to rows the user has seen).

Note: the opportunity-providers demo tab shares `ParticipantTable`, so it
inherits the same selection + bulk bar with no special-casing.
