# Aggregator Dashboard — Adopt Signals' Canonical-Bucket Contract

**Status:** spec — awaiting implementation plan
**Author:** generated via brainstorming session, 2026-05-26
**Reference network:** Purple Dot (pilot)
**Sibling repo:** `../Signals-DPG/` (this spec depends on a small follow-up PR there — see §6.A)
**Branch (this repo):** `feat/signals-canonical-dashboard` (off `origin/feature`)

## Goal

Adapt aggregator-dpg's dashboard consumer surface to Signals' new canonical-bucket dashboard contract (Signals PR #26, now on develop). Renames `participants` → `items`, drops the `applications_*` rollup fields, adopts `count_create/accept/reject/cancel` + `last_*_at` per row, exposes `by_action_status` / `avg_*` / `mode_wise_counts` rollups, and adds a `?refresh=true` knob backed by a UI button.

Tile labels currently hardcoded in the dashboard page ("Open Roles", "Hires This Month") move to the network's `network.json` so per-network copy lives where the network identity does. The aggregator already fetches `network.json` from `network.source` (see `aggregator.config.yaml`); we extend the parsed shape to carry the labels, surface them through the existing `/v1/aggregator-config` payload, and consume them in the UI.

## Why now

Signals' canonical-bucket dashboard merged. Aggregator-DPG's `signalstack-writer` interface, HTTP impl, in-memory fake, BFF dashboard route, and dashboard UI all still encode the OLD shape (`participants[]`, `applications_total`, `applications_pending`, `applications_shortlisted`, `applications_rejected`, `unique_users`, `complete_profiles_count`, `avg_profiles_per_user`, `users_with_applications`, `avg_applications_per_user`, `new_users_last_7_days`, `items_total`). Without this update, the live aggregator portal will start showing zeros or stale data once an operator points at a stack running the new Signals contract.

Pilot for Purple Dot also wants a "Refresh" button so an operator can force a recompute after submitting a batch of registrations.

## Dependencies

- Signals-DPG PR #26 (canonical-bucket dashboard) — already merged to develop.
- A small Signals-DPG follow-up PR adding `dashboard_tiles` (per domain) and `dashboard_buckets` (top-level) to the 3 reference `network.json` files plus the `NetworkConfigSchema` Zod validator. See §6.A. Must merge before the aggregator-side UI lands so the consumer actually sees the labels.

## Non-goals

- Renaming aggregator's own `participants` table (that's a different concept — aggregator's per-network roster).
- New tiles beyond the 3 existing per-domain ones (per the "minimal map" scope choice).
- Backward-compatibility shims for the old shape; Signals is fully cut over.
- Translation / localization plumbing for the labels (the labels are English strings in network.json; i18n is future).
- Refactoring `dashboard/page.tsx` beyond the targeted edits.

---

## §1 — Contract layer (`packages/signalstack-writer/src/interface.ts`)

### Query DTOs — add `refresh`

```ts
export interface SignalStackDashboardQuery {
  actingOrgId: string;
  page?: number;
  limit?: number;
  status?: string;
  domain?: string;
  refresh?: boolean; // NEW — forwarded as `?refresh=true` when truthy
}

export interface SignalStackDashboardExportQuery {
  actingOrgId: string;
  status?: string;
  domain?: string;
  refresh?: boolean; // NEW
}
```

### Rollup — replace the 13-field shape with 8 fields

```ts
export interface SignalStackDashboardRollup {
  // 3 item-scoped tiles
  total_items: number;
  complete_profiles: number;
  has_applications: number;

  // 2 histograms (canonical 4-key vocab; consumers tolerate missing keys defensively)
  by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
  by_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;

  // 2 user-level averages
  avg_items_per_user: number;
  avg_actions_per_user: number;

  // open histogram, retained
  mode_wise_counts: Record<string, number>;
}
```

Dropped from the old shape: `items_total`, `applications_total`, `applications_pending`, `applications_shortlisted`, `applications_rejected`, `unique_users`, `complete_profiles_count`, `avg_profiles_per_user`, `users_with_applications`, `avg_applications_per_user`, `new_users_last_7_days`.

### Domain slice — `participants` renamed to `items`

```ts
export interface SignalStackDashboardDomainSlice {
  rollup: SignalStackDashboardRollup;
  items: Array<Record<string, unknown>>; // RENAMED from `participants`
  total_matching: number;
  next_cursor: string | null;
}
```

Row shape stays `Record<string, unknown>` — the writer doesn't pin per-row keys (Signals' row shape evolves independently). Consumers (the UI) read keys defensively.

### Status enum

The aggregator passes `status` as a freeform string already, so no type change is needed there. Signals dropped the `satisfied` value; aggregator code that ever encoded `'satisfied'` as a status filter will return zero matches — confirm by grep before final commit.

---

## §2 — HTTP impl (`packages/signalstack-writer/src/http.ts`)

`fetchDashboard(query)` builds its URL via a `URLSearchParams`-style assembly (current code around line 403-420). Add:

```ts
if (query.refresh) searchParams.set('refresh', 'true');
```

Same one-line addition in `exportDashboardCsv()` (around line 518).

**Runtime validation** (~line 455 where `payload.by_domain` is checked):

- `by_domain[id].participants` → `by_domain[id].items`.
- Drop checks for the 13 dropped rollup keys.
- Add positive presence checks for `total_items` (number), `by_action_status` (object), `by_status` (object). Missing → throw an `UpstreamError` with code `MALFORMED_DASHBOARD_PAYLOAD`.
- `complete_profiles`, `has_applications`, `avg_items_per_user`, `avg_actions_per_user`, `mode_wise_counts` typed but not strictly required at runtime (defensive — Signals may evolve).

No other change.

---

## §3 — In-memory fake (`packages/signalstack-writer/src/memory.ts`)

Two updates:

(a) The synthesised default rollup (around line 252) when `seedDashboard()` hasn't been called explicitly:

```ts
const defaultRollup = (): SignalStackDashboardRollup => ({
  total_items: 0,
  complete_profiles: 0,
  has_applications: 0,
  by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
  by_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
  avg_items_per_user: 0,
  avg_actions_per_user: 0,
  mode_wise_counts: {},
});
```

(b) The helper that builds sample row records (around line 340) — rename `applications_*` → `count_*`, add `last_create_at / last_accept_at / last_reject_at / last_cancel_at` (nullable), add `name` (resolved by Signals from schema's `display_name_field` or item_id fallback), keep `item_network` + `item_domain` + `item_type` + `onboarded_via` + `profile_status` + `profile_completion_pct` + `profile_created_at` + `profile_last_updated_at` + `age_days` + `actionable_tags`. Drop `item_id`, `owner_user_id`, `onboarded_by_org_id` from the row (Signals dropped these from the API response).

`seedDashboard()` public API stays the same; internal storage updated to match.

---

## §4 — BFF dashboard route (`apps/api/src/routes/dashboard.ts`)

- `DashboardQuerySchema`: add `refresh: z.coerce.boolean().optional().default(false)`.
- `ExportQuerySchema`: same `refresh` field.
- Handler at line 177 currently calls `ss.fetchDashboard({ actingOrgId, page, limit, ...(status ? { status } : {}), domain })`. Add `refresh`:

```ts
const result = await ss.fetchDashboard({
  actingOrgId,
  page,
  limit,
  ...(status ? { status } : {}),
  domain,
  refresh,
});
```

Same edit in the export handler around line 253.

Response passes through verbatim — no transform. The UI consumes `by_domain[<id>]` directly.

---

## §5 — Network config types (`packages/network-config/src/interface.ts`)

Extend `NetworkDomain` and `SignalstackNetwork`:

```ts
export interface DashboardTileLabels {
  total_items?: string;
  complete_profiles?: string;
  has_applications?: string;
}

export interface DashboardBuckets {
  by_status?: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', string>>;
  by_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
}

export interface NetworkDomain {
  id: string;
  description?: string;
  dashboard_tiles?: DashboardTileLabels; // NEW — passes through from network.json
  item_schemas: Record<string, Record<string, unknown>>;
}

export interface SignalstackNetwork {
  id: string;
  display_name?: string;
  description?: string;
  domains: NetworkDomain[];
  dashboard_buckets?: DashboardBuckets; // NEW — passes through from network.json
  [extra: string]: any;
}

export interface ResolvedDomain {
  id: string;
  label: string;
  pluralLabel: string;
  itemType: string;
  schema: Record<string, unknown>;
  identity: IdentitySelectors;
  dashboardTiles?: DashboardTileLabels; // NEW — resolved passthrough
}

export interface ResolvedNetworkConfig {
  aggregator: AggregatorYaml['aggregator'];
  network: SignalstackNetwork;
  domains: Record<string, ResolvedDomain>;
  domainIds: string[];
  dashboardBuckets?: DashboardBuckets; // NEW — convenience extracted from network root
}
```

These are pure passthrough — the aggregator doesn't validate label content beyond optional string typing.

## §6 — Network config loader (`packages/network-config/src/loader.ts`)

At the merge step where `ResolvedDomain` and `ResolvedNetworkConfig` are assembled from the raw `SignalstackNetwork` JSON, copy:

- `domain.dashboard_tiles` (raw) → `ResolvedDomain.dashboardTiles`
- `network.dashboard_buckets` (raw) → `ResolvedNetworkConfig.dashboardBuckets`

No validation beyond the optional-string types in the interface. Network.json is the source of truth; the aggregator trusts it.

## §6.A — Signals-DPG side (separate small PR)

Tracked in this spec for visibility; lives in `../Signals-DPG/`. Adds:

1. `examples/schemas/purple_dot/network.json` — add `dashboard_tiles` to each domain entry and `dashboard_buckets` at the network root. Suggested copy:

   ```jsonc
   "dashboard_buckets": {
     "by_status":        { "new": "New", "active": "Active", "at_risk": "At Risk", "inactive": "Inactive" },
     "by_action_status": { "create": "Requested", "accept": "Connected", "reject": "Declined", "cancel": "Cancelled" }
   }
   ```

   Per-domain tiles for purple_dot:
   - seeker: `total_items: "Total Beneficiaries"`, `complete_profiles: "Profiles Complete"`, `has_applications: "Made Connections"`
   - provider: `total_items: "Total Service Providers"`, `complete_profiles: "Profiles Complete"`, `has_applications: "Received Connections"`

2. `examples/schemas/blue_dot/network.json` — analogous:

   ```jsonc
   "dashboard_buckets": {
     "by_status":        { "new": "New", "active": "Active", "at_risk": "At Risk", "inactive": "Inactive" },
     "by_action_status": { "create": "Applied", "accept": "Shortlisted", "reject": "Rejected", "cancel": "Withdrawn" }
   }
   ```

   - seeker: `total_items: "Total Job Seekers"`, `complete_profiles: "Profiles Complete"`, `has_applications: "Applied for Jobs"`
   - provider: `total_items: "Total Job Postings"`, `complete_profiles: "Postings Complete"`, `has_applications: "Received Applications"`

3. `examples/schemas/yellow_dot/network.json` — optional, add similar block with generic copy.

4. `packages/schemas/src/network_workflow.ts` Zod schema — extend `NetworkDomainSchema` with `dashboard_tiles: z.object({...}).optional()` (record of 3 optional string fields), and extend `NetworkConfigSchema` root with `dashboard_buckets: z.object({...}).optional()`. Both `.strict()` at the inner level so unknown keys get caught early.

## §7 — `/v1/aggregator-config` route

The route returns `ResolvedNetworkConfig` verbatim. New fields surface automatically. Verify any response Zod (likely none — it's a passthrough) is updated.

The web BFF (`apps/web/src/app/api/aggregator-config/route.ts`) also passes through.

The `useAggregatorConfig()` hook's `AggregatorConfigPayload` TypeScript type — extend to include the new fields so the UI gets type-safe access.

## §8 — UI (`apps/web/src/app/(protected)/dashboard/page.tsx`)

Three concrete edits, in order:

### (a) Field renames

`toSeekerRow` and `toProviderRow` (around line 869 and 1057) and rollup card pickers:

```ts
// rollup
rollup?.items_total                  → rollup?.total_items
rollup?.complete_profiles_count      → rollup?.complete_profiles
rollup?.applications_total           → (computed) (rollup?.by_action_status?.create ?? 0)
                                                + (rollup?.by_action_status?.accept ?? 0)
                                                + (rollup?.by_action_status?.reject ?? 0)
                                                + (rollup?.by_action_status?.cancel ?? 0)
                                       // — or use rollup?.has_applications for "items engaged"
rollup?.applications_pending         → rollup?.by_action_status?.create
rollup?.applications_shortlisted     → rollup?.by_action_status?.accept
rollup?.applications_rejected        → rollup?.by_action_status?.reject

// slice
slice?.participants                  → slice?.items

// row
participant.applications_total       → (computed) sum of count_create + count_accept + count_reject + count_cancel
participant.applications_accepted    → participant.count_accept
participant.applications_rejected    → participant.count_reject
participant.applications_pending     → participant.count_create
participant.last_applied_at          → max of last_create_at / last_accept_at / last_reject_at / last_cancel_at
                                       (null if all are null)
participant.name                     → (no change — Signals now resolves this server-side from display_name_field)
```

`item_id`, `owner_user_id`, `onboarded_by_org_id` no longer exist on rows — any UI reference must be removed (the existing rows didn't surface these per the current code, so this is a defensive cleanup).

### (b) Label sourcing from `useAggregatorConfig()`

Replace hardcoded tile titles with config lookups + fallbacks:

```tsx
const { data: cfg } = useAggregatorConfig();
const domainCfg = cfg?.domains?.[domain];
const pluralLabel = domainCfg?.pluralLabel ?? 'Items';
const tileLabels = domainCfg?.dashboardTiles ?? {};
const bucketLabels = cfg?.dashboardBuckets?.by_action_status ?? DEFAULT_BUCKET_LABELS;
const statusLabels = cfg?.dashboardBuckets?.by_status ?? DEFAULT_STATUS_LABELS;

const DEFAULT_BUCKET_LABELS = {
  create: 'Created', accept: 'Accepted', reject: 'Rejected', cancel: 'Cancelled',
} as const;
const DEFAULT_STATUS_LABELS = {
  new: 'New', active: 'Active', at_risk: 'At Risk', inactive: 'Inactive',
} as const;

<Card title={tileLabels.total_items ?? `Total ${pluralLabel}`}>{rollup?.total_items ?? 0}</Card>
<Card title={tileLabels.complete_profiles ?? 'Profiles Complete'}>{rollup?.complete_profiles ?? 0}</Card>
<Card title={tileLabels.has_applications ?? 'Engaged'}>{rollup?.has_applications ?? 0}</Card>
```

The seeker domain block (currently around line 760-880) and provider domain block (around line 950-1070) both apply this pattern. They differ only in the table row mapper (`toSeekerRow` vs `toProviderRow`) and the `domain` value passed in.

### (c) Refresh button

Place next to the page title. Standard React Query pattern:

```tsx
const queryClient = useQueryClient();
const [refreshing, setRefreshing] = useState(false);

async function handleRefresh() {
  setRefreshing(true);
  try {
    // Direct invalidate-and-refetch with refresh=true forced
    await jsonFetch(
      `/api/dashboard?domain=${domain}&page=${page}&limit=${limit}&refresh=true${status ? `&status=${status}` : ''}`,
    );
    await queryClient.invalidateQueries({
      queryKey: ['dashboard', { domain, page, limit, status }],
    });
  } finally {
    setRefreshing(false);
  }
}

<button
  onClick={handleRefresh}
  disabled={refreshing}
  aria-label="Refresh dashboard"
  title="Refresh dashboard"
>
  <RefreshIcon className={refreshing ? 'animate-spin' : ''} />
</button>;
```

If a `useDashboardQuery` hook exists, the cleaner pattern is to invalidate by query key and let React Query refetch with `refresh: true` injected into the request params. Match the existing data-fetching style in the page (the brainstorming exploration showed React Query keyed on `['aggregator-config']` already).

`metadata.refreshed` from the response: surface as a small "Refreshed just now" caption that flips back to "Last updated: <time>" after 5 seconds.

---

## §9 — Tests

Two layers:

**Unit / contract:**

- `packages/signalstack-writer/src/__tests__/http.test.ts` — assert new URL building with `?refresh=true`; assert runtime validation accepts new shape and rejects malformed payload.
- `packages/signalstack-writer/src/__tests__/memory.test.ts` — assert default rollup shape; assert seeded row shape.
- `packages/network-config/src/__tests__/loader.test.ts` — assert `dashboardTiles` and `dashboardBuckets` resolve from a network.json fixture with the new blocks.

**Integration:**

- `apps/api/src/routes/dashboard.test.ts` — update fixtures to new shape; assert `refresh` query param flows through to the writer.
- Web tests (if any covering the dashboard page) — update field references and assert the Refresh button triggers a refetch.

## §10 — Out of scope

- New rollup tiles beyond the existing 3 per domain.
- Per-locale label overrides (i18n).
- Reading `last_*_at` timestamps from individual rows into a UI column (the data is fetched but not surfaced in the current row layout).
- Changing the aggregator's internal `participants` table or any of the `signalstack-writer`'s WRITE paths (create_user, create_item).
- Renaming `useDashboard` / restructuring `dashboard/page.tsx`.

## §11 — Spec self-review

- **Placeholders:** none. Every field rename, every new key, every callsite is explicit.
- **Internal consistency:** rollup field set is identical between §1 (contract), §3 (fake), §4 (BFF), §8 (UI). Bucket vocab `create/accept/reject/cancel` and status vocab `new/active/at_risk/inactive` repeat verbatim across sections.
- **Scope:** focused on dashboard contract adoption + label config. No drive-by refactoring. Two repos touched only because the labels conceptually belong in network.json (Signals owns it); aggregator's PR can land first, with the Signals follow-up triggering label population when it merges. Until then, the UI falls back to defaults (`Total Items`, `Created/Accepted/Rejected/Cancelled`, etc.).
- **Ambiguity:** `applications_total` ← in the OLD shape this meant total actions in any state; in the NEW shape we either compute it as the sum of `by_action_status.*` (kept for back-compat in the UI's "Total Applications" tile) OR use `has_applications` (count of rows with ≥1 action). Spec §8 calls out the choice (`applications_total` → derived sum; `has_applications` is its own optional tile if we want one).
- **Ordering:** Signals follow-up PR (§6.A) can land in parallel — UI ships safe defaults; labels arrive when network.json is republished. No blocking dependency.

## §12 — Test plan (operator-side, manual)

After implementation:

1. Run aggregator-dpg locally (`make up`).
2. Open the dashboard for a Purple Dot org.
3. **Verify tile titles** match the labels declared in purple_dot's `network.json` (once Signals follow-up PR is in): e.g. "Total Beneficiaries" not "Total Items".
4. **Verify bucket labels** in any per-bucket UI element: "Requested / Connected / Declined / Cancelled" instead of "create / accept / reject / cancel".
5. **Verify row values** map correctly: count_create populates the "Pending" column, count_accept the "Accepted" column, etc.
6. **Verify Refresh button**: click it, see the spinner, see `metadata.refreshed: true` flow through (e.g. "Refreshed just now" caption).
7. **Verify CSV export** still works and `?refresh=true` is honored on it.
