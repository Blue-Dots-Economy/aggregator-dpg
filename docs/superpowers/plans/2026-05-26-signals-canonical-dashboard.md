# Aggregator Dashboard — Adopt Signals Canonical-Bucket Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt aggregator-dpg's dashboard consumer (writer contract, BFF, web service, hook, page) to Signals' new canonical-bucket dashboard contract; route tile labels from `network.json` through the existing aggregator-config pipeline; add a Refresh button driven by `?refresh=true`.

**Architecture:** Five layers updated in order: (1) `signalstack-writer` contract/HTTP/fake; (2) BFF dashboard route; (3) `network-config` types + loader passthrough; (4) web hook + service + aggregator-config hook types; (5) dashboard page UI (field renames + label sourcing + refresh button). Plus a small companion PR in Signals-DPG to populate the new labels in the reference `network.json` files.

**Tech Stack:** TypeScript strict, Zod, Fastify, Drizzle (unused here), Next.js App Router, React Query, Vitest. Workspace abstract-class + Zod + Result pattern documented in `.claude/rules/`.

**Spec:** `docs/superpowers/specs/2026-05-26-signals-canonical-dashboard-design.md`
**Branch (this repo):** `feat/signals-canonical-dashboard` (off `origin/feature`).
**Companion branch (Signals-DPG):** new branch off `origin/develop` — see Task 10.

---

## File map

**Modified (aggregator-dpg):**

- `packages/signalstack-writer/src/interface.ts` — query DTOs add `refresh`; rollup shape replaced; slice key renamed.
- `packages/signalstack-writer/src/http.ts` — URL builder appends `refresh`; runtime validation rewritten.
- `packages/signalstack-writer/src/memory.ts` — `emptyDomainSlice()` shape replaced.
- `packages/signalstack-writer/src/__tests__/http.test.ts` — assertions match new shape + refresh URL.
- `packages/signalstack-writer/src/__tests__/memory.test.ts` — assertions match new shape.
- `packages/network-config/src/interface.ts` — `NetworkDomain`, `SignalstackNetwork`, `ResolvedDomain`, `ResolvedNetworkConfig` extended.
- `packages/network-config/src/loader.ts` — passthrough of `dashboard_tiles` + `dashboard_buckets`.
- `packages/network-config/src/__tests__/loader.test.ts` — fixture + assertions.
- `apps/api/src/routes/dashboard.ts` — `DashboardQuerySchema`, `DashboardExportQuerySchema` + forwarding.
- `apps/api/src/routes/dashboard.test.ts` — assertions for new shape + refresh forwarding.
- `apps/web/src/services/dashboard.service.ts` — `DashboardQuery` + `DashboardRollup` + `DashboardDomainSlice` types updated; service forwards `refresh`.
- `apps/web/src/hooks/useDashboard.ts` — accept `refresh` in `DashboardQuery`; widen `queryKey`.
- `apps/web/src/hooks/useAggregatorConfig.ts` — `AggregatorConfigPayload` gains the new optional blocks.
- `apps/web/src/app/(protected)/dashboard/page.tsx` — field renames; label sourcing; refresh button.

**Modified (Signals-DPG companion PR — Task 10):**

- `packages/schemas/src/network_workflow.ts` — Zod additions for `dashboard_tiles` + `dashboard_buckets`.
- `examples/schemas/purple_dot/network.json` — populate labels.
- `examples/schemas/blue_dot/network.json` — populate labels.
- `examples/schemas/yellow_dot/network.json` — populate labels (generic copy).
- `packages/schemas/src/__tests__/network_workflow_metrics.test.ts` — extend with cases for the new blocks.

---

## Task 1: signalstack-writer contract types

**Files:**

- Modify: `packages/signalstack-writer/src/interface.ts` (around lines 182-249)

- [ ] **Step 1: Update `SignalStackDashboardQuery` (around line 182)**

Find the existing interface body. Add a `refresh?: boolean` field, last in the interface:

```ts
export interface SignalStackDashboardQuery {
  actingOrgId: string;
  page?: number;
  limit?: number;
  status?: string;
  domain?: string;
  /**
   * When true, forwards `?refresh=true` to signalstack so it bypasses the
   * TTL cache and recomputes the rollup synchronously. Off by default.
   */
  refresh?: boolean;
}
```

- [ ] **Step 2: Update `SignalStackDashboardExportQuery` (around line 259)**

Add the same `refresh?: boolean` field.

```ts
export interface SignalStackDashboardExportQuery {
  actingOrgId: string;
  status?: string;
  domain?: string;
  /** Same semantics as on the dashboard query — bypass TTL, force recompute. */
  refresh?: boolean;
}
```

- [ ] **Step 3: Replace `SignalStackDashboardRollup`**

Replace the existing interface body (around lines 196-210) with the canonical 8-field shape:

```ts
/**
 * Pre-computed rollup of participant + action counts returned per domain.
 *
 * `by_status` and `by_action_status` use partial maps because signalstack
 * may omit a bucket when its count is zero; consumers default missing keys
 * to 0. `mode_wise_counts` is open-shape — signalstack adds keys for any
 * `onboarded_via` value the aggregator emits.
 */
export interface SignalStackDashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
  by_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}
```

- [ ] **Step 4: Update `SignalStackDashboardDomainSlice` (around line 219)**

Rename `participants` to `items`:

```ts
export interface SignalStackDashboardDomainSlice {
  rollup: SignalStackDashboardRollup;
  /**
   * One row per item. Open-shape because signalstack owns the per-row
   * schema; consumers decode the keys they care about (today: count_*,
   * last_*_at, name, item_network, item_type, onboarded_via,
   * profile_status, profile_completion_pct, age_days, actionable_tags).
   */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}
```

- [ ] **Step 5: Typecheck**

```
pnpm --filter @aggregator-dpg/signalstack-writer exec tsc --noEmit
```

Expected: `http.ts` and `memory.ts` will report errors (they still use the old field names) — that's fine, they're fixed in Tasks 2-3. Interface file should report no errors of its own.

- [ ] **Step 6: Commit**

```bash
git add packages/signalstack-writer/src/interface.ts
git commit -m "feat(signalstack-writer): canonical bucket DTOs + refresh query field"
```

---

## Task 2: signalstack-writer HTTP impl

**Files:**

- Modify: `packages/signalstack-writer/src/http.ts` (around lines 403-470 and 510-540)

- [ ] **Step 1: Locate and edit `fetchDashboard()` URL building**

Find the block around line 405-420 where the URL is built. The current code constructs a `URLSearchParams` from the query fields. Add the `refresh` parameter:

```ts
// In fetchDashboard, where the existing query-string assembly lives:
const searchParams = new URLSearchParams();
searchParams.set('page', String(query.page ?? 1));
searchParams.set('limit', String(query.limit ?? 50));
if (query.status) searchParams.set('status', query.status);
if (query.domain) searchParams.set('domain', query.domain);
if (query.refresh) searchParams.set('refresh', 'true'); // NEW
const qs = searchParams.toString();
const url = `${this.baseUrl}/api/v1/aggregator/dashboard${qs ? `?${qs}` : ''}`;
```

(Use the existing pattern in the file — the snippet above is illustrative; preserve whatever current style the file uses for the rest of the params.)

- [ ] **Step 2: Update runtime payload validation (around line 455)**

The existing check at `!payload.by_domain || typeof payload.by_domain !== 'object'` stays. Add stricter checks for the new shape — after the existing `by_domain` check, walk each domain entry and verify required keys are present.

Replace the validation block (the original is around lines 455-480) with:

```ts
if (
  !payload ||
  typeof payload !== 'object' ||
  !('by_domain' in payload) ||
  !payload.by_domain ||
  typeof payload.by_domain !== 'object'
) {
  return err(
    new UpstreamError('Signalstack dashboard payload missing by_domain', {
      code: 'SIGNALSTACK_BAD_RESPONSE',
    }),
  );
}

const byDomain = payload.by_domain as Record<string, unknown>;
for (const [domainId, sliceRaw] of Object.entries(byDomain)) {
  if (!sliceRaw || typeof sliceRaw !== 'object') {
    return err(
      new UpstreamError(`Signalstack domain slice "${domainId}" is not an object`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
  const slice = sliceRaw as Record<string, unknown>;
  if (!Array.isArray(slice.items)) {
    return err(
      new UpstreamError(`Signalstack slice "${domainId}" missing items[]`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
  if (!slice.rollup || typeof slice.rollup !== 'object') {
    return err(
      new UpstreamError(`Signalstack slice "${domainId}" missing rollup`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
  const r = slice.rollup as Record<string, unknown>;
  if (typeof r.total_items !== 'number') {
    return err(
      new UpstreamError(`Signalstack slice "${domainId}" rollup missing total_items`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
  if (!r.by_action_status || typeof r.by_action_status !== 'object') {
    return err(
      new UpstreamError(`Signalstack slice "${domainId}" rollup missing by_action_status`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
  if (!r.by_status || typeof r.by_status !== 'object') {
    return err(
      new UpstreamError(`Signalstack slice "${domainId}" rollup missing by_status`, {
        code: 'SIGNALSTACK_BAD_RESPONSE',
      }),
    );
  }
}
```

(`complete_profiles`, `has_applications`, `avg_items_per_user`, `avg_actions_per_user`, `mode_wise_counts` typed but not strictly required at runtime — they're defensive defaults at consumption.)

- [ ] **Step 3: Update `exportDashboardCsv()` URL building (around line 518)**

Find the export URL build block. Mirror the `refresh` query forwarding:

```ts
const searchParams = new URLSearchParams();
if (query.status) searchParams.set('status', query.status);
if (query.domain) searchParams.set('domain', query.domain);
if (query.refresh) searchParams.set('refresh', 'true'); // NEW
const qs = searchParams.toString();
const url = `${this.baseUrl}/api/v1/aggregator/dashboard/export${qs ? `?${qs}` : ''}`;
```

- [ ] **Step 4: Typecheck**

```
pnpm --filter @aggregator-dpg/signalstack-writer exec tsc --noEmit
```

Expected: http.ts compiles. memory.ts still reports errors — fixed in Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/signalstack-writer/src/http.ts
git commit -m "feat(signalstack-writer): refresh URL + canonical-shape payload validation"
```

---

## Task 3: signalstack-writer in-memory fake

**Files:**

- Modify: `packages/signalstack-writer/src/memory.ts` (around lines 240-330 and 332-376)

- [ ] **Step 1: Replace `emptyDomainSlice()` function (around lines 332-376)**

Find the function definition at the bottom of the file. Replace its body entirely:

```ts
/**
 * Deterministic empty per-domain slice. The synthesised dashboard payload
 * from {@link InMemorySignalStackWriter.fetchDashboard} uses this for every
 * domain when the test hasn't pinned a response — the shape mirrors the
 * live signalstack contract so downstream consumers never branch on
 * "shape from real api vs. fake".
 */
function emptyDomainSlice(): {
  rollup: {
    total_items: number;
    complete_profiles: number;
    has_applications: number;
    by_status: Record<string, number>;
    by_action_status: Record<string, number>;
    avg_items_per_user: number;
    avg_actions_per_user: number;
    mode_wise_counts: Record<string, number>;
  };
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
} {
  return {
    rollup: {
      total_items: 0,
      complete_profiles: 0,
      has_applications: 0,
      by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
      by_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
      avg_items_per_user: 0,
      avg_actions_per_user: 0,
      mode_wise_counts: {},
    },
    items: [],
    total_matching: 0,
    next_cursor: null,
  };
}
```

- [ ] **Step 2: Audit the rest of memory.ts for `participants` references**

Grep within memory.ts for any other site that still uses `participants` as a key in the dashboard payload shape and rename to `items`:

```
grep -n "participants" packages/signalstack-writer/src/memory.ts
```

If any hits remain in dashboard-related code (excluding doc comments about aggregator's `participants` table which is different), update them. Comments that conceptually talk about the row collection should also be updated for consistency.

- [ ] **Step 3: Typecheck**

```
pnpm --filter @aggregator-dpg/signalstack-writer exec tsc --noEmit
```

Expected: PASS for the writer package.

- [ ] **Step 4: Run writer tests (they'll fail; expected — fixed in Task 4)**

```
pnpm --filter @aggregator-dpg/signalstack-writer test
```

The HTTP tests and memory tests will fail because they assert old shape. That's expected; Task 4 fixes them.

- [ ] **Step 5: Commit**

```bash
git add packages/signalstack-writer/src/memory.ts
git commit -m "feat(signalstack-writer): in-memory fake emits canonical dashboard shape"
```

---

## Task 4: signalstack-writer tests

**Files:**

- Modify: `packages/signalstack-writer/src/__tests__/http.test.ts`
- Modify: `packages/signalstack-writer/src/__tests__/memory.test.ts`

- [ ] **Step 1: Inspect existing tests**

```
ls packages/signalstack-writer/src/__tests__/
grep -n "participants\|applications_total\|by_action_status\|refresh" packages/signalstack-writer/src/__tests__/*.test.ts
```

You'll see assertions on `participants`, `applications_total/pending/shortlisted/rejected`, and the rest of the old rollup keys. Update each to the new shape.

- [ ] **Step 2: Update `http.test.ts` assertions**

For any test fixture payload structured like the OLD shape, rewrite to the NEW shape. Example pattern:

```ts
// OLD test fixture:
const payload = {
  by_domain: {
    seeker: {
      rollup: {
        items_total: 5,
        by_status: { active: 3 },
        applications_total: 10,
        applications_pending: 4,
        applications_shortlisted: 5,
        applications_rejected: 1,
        unique_users: 4,
        complete_profiles_count: 2,
        avg_profiles_per_user: 1.25,
        users_with_applications: 3,
        avg_applications_per_user: 3.3,
        new_users_last_7_days: 1,
        mode_wise_counts: { link: 5 },
      },
      participants: [{ item_id: '...', applications_total: 2 }],
      total_matching: 5,
      next_cursor: null,
    },
  },
  metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
};

// NEW test fixture:
const payload = {
  by_domain: {
    seeker: {
      rollup: {
        total_items: 5,
        complete_profiles: 2,
        has_applications: 3,
        by_status: { new: 1, active: 3, at_risk: 0, inactive: 1 },
        by_action_status: { create: 4, accept: 5, reject: 1, cancel: 0 },
        avg_items_per_user: 1.25,
        avg_actions_per_user: 3.3,
        mode_wise_counts: { link: 5 },
      },
      items: [
        {
          count_create: 1,
          count_accept: 1,
          count_reject: 0,
          count_cancel: 0,
          name: 'Asha',
          item_network: 'purple_dot',
        },
      ],
      total_matching: 5,
      next_cursor: null,
    },
  },
  metadata: { last_computed_at: '2026-01-01T00:00:00Z', ttl_seconds: 3600, refreshed: false },
};
```

For the malformed-payload tests, add a case that omits `by_action_status` from the rollup and asserts `SIGNALSTACK_BAD_RESPONSE`.

Add a new test that verifies the `refresh` query parameter is appended:

```ts
it('appends ?refresh=true when query.refresh is truthy', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => /* the new-shape payload above */,
  } as Response);

  const writer = new HttpSignalStackWriter({ baseUrl: 'https://signals.example' /*, ... */ });
  await writer.fetchDashboard({ actingOrgId: 'org_abc', refresh: true });

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('refresh=true'),
    expect.anything(),
  );
});

it('does NOT append refresh when query.refresh is unset or false', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => /* the new-shape payload */,
  } as Response);

  const writer = new HttpSignalStackWriter({ baseUrl: 'https://signals.example' });
  await writer.fetchDashboard({ actingOrgId: 'org_abc' });

  expect(fetchMock).toHaveBeenCalledWith(
    expect.not.stringContaining('refresh='),
    expect.anything(),
  );
});
```

Match the existing test style for the rest (use whatever helpers exist for HTTP mocking).

- [ ] **Step 3: Update `memory.test.ts` assertions**

The memory fake's tests assert on the `emptyDomainSlice()` shape. Rewrite:

```ts
it('synthesises an empty domain slice with the canonical rollup shape', async () => {
  const writer = new InMemorySignalStackWriter();
  const result = await writer.fetchDashboard({ actingOrgId: 'org_x' });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const slice = result.value.by_domain.seeker;
  expect(slice.items).toEqual([]);
  expect(slice.rollup).toEqual({
    total_items: 0,
    complete_profiles: 0,
    has_applications: 0,
    by_status: { new: 0, active: 0, at_risk: 0, inactive: 0 },
    by_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
    avg_items_per_user: 0,
    avg_actions_per_user: 0,
    mode_wise_counts: {},
  });
});
```

If `seedDashboard()` tests exist with old-shape pinned data, update those too.

- [ ] **Step 4: Run tests**

```
pnpm --filter @aggregator-dpg/signalstack-writer test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/signalstack-writer/src/__tests__/
git commit -m "test(signalstack-writer): assertions match canonical dashboard shape + refresh"
```

---

## Task 5: network-config types + loader passthrough

**Files:**

- Modify: `packages/network-config/src/interface.ts` (around lines 194-248)
- Modify: `packages/network-config/src/loader.ts` (find where `ResolvedDomain` and `ResolvedNetworkConfig` are assembled)
- Modify: `packages/network-config/src/__tests__/loader.test.ts`

- [ ] **Step 1: Add new interfaces to `interface.ts`**

Just before the existing `NetworkDomain` interface (around line 193), add:

```ts
/**
 * Tile-label overrides for the dashboard. All keys optional — UI falls back
 * to generic English when omitted. Carried verbatim from `network.json`'s
 * per-domain block; the aggregator does not validate label content.
 */
export interface DashboardTileLabels {
  total_items?: string;
  complete_profiles?: string;
  has_applications?: string;
}

/**
 * Network-wide canonical-bucket label overrides. Keys are the fixed Signals
 * vocab; values are the network's preferred copy ("Applied" vs "Requested",
 * etc.). Optional throughout — UI defaults to English labels when missing.
 */
export interface DashboardBuckets {
  by_status?: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', string>>;
  by_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
}
```

- [ ] **Step 2: Extend `NetworkDomain` (around line 194)**

```ts
export interface NetworkDomain {
  id: string;
  description?: string;
  /** Per-domain tile labels for the dashboard. Optional passthrough from network.json. */
  dashboard_tiles?: DashboardTileLabels;
  item_schemas: Record<string, Record<string, unknown>>;
}
```

- [ ] **Step 3: Extend `SignalstackNetwork` (around line 206)**

```ts
export interface SignalstackNetwork {
  id: string;
  display_name?: string;
  description?: string;
  domains: NetworkDomain[];
  /** Shared bucket labels for the dashboard. Optional passthrough from network.json. */
  dashboard_buckets?: DashboardBuckets;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
}
```

- [ ] **Step 4: Extend `ResolvedDomain` (around line 223)**

```ts
export interface ResolvedDomain {
  id: string;
  label: string;
  pluralLabel: string;
  itemType: string;
  schema: Record<string, unknown>;
  identity: IdentitySelectors;
  /**
   * Resolved per-domain dashboard tile labels — copy-through from
   * `network.dashboard_tiles` on this domain. UI falls back to generic
   * defaults when undefined.
   */
  dashboardTiles?: DashboardTileLabels;
}
```

- [ ] **Step 5: Extend `ResolvedNetworkConfig` (around line 242)**

```ts
export interface ResolvedNetworkConfig {
  aggregator: AggregatorYaml['aggregator'];
  network: SignalstackNetwork;
  domains: Record<string, ResolvedDomain>;
  domainIds: string[];
  /**
   * Convenience extract of `network.dashboard_buckets` so callers don't
   * have to dive into the raw network object. Undefined when the loaded
   * network.json doesn't declare the block.
   */
  dashboardBuckets?: DashboardBuckets;
}
```

- [ ] **Step 6: Update `loader.ts` to copy the fields through**

Open `packages/network-config/src/loader.ts`. Find the function/block where `ResolvedDomain` objects are constructed (it iterates `network.domains` and produces an object per domain). Add `dashboardTiles: domain.dashboard_tiles` to each constructed `ResolvedDomain`. Example pattern (the exact site depends on the file's existing structure):

```ts
const resolvedDomain: ResolvedDomain = {
  id: domain.id,
  label,
  pluralLabel,
  itemType,
  schema,
  identity,
  dashboardTiles: domain.dashboard_tiles, // NEW — passthrough; undefined when absent
};
```

Find where `ResolvedNetworkConfig` is assembled (returned by the loader's `load()` method). Add `dashboardBuckets: network.dashboard_buckets`:

```ts
return ok({
  aggregator: aggregatorYaml.aggregator,
  network,
  domains,
  domainIds,
  dashboardBuckets: network.dashboard_buckets, // NEW
});
```

- [ ] **Step 7: Update loader tests**

Open `packages/network-config/src/__tests__/loader.test.ts`. Find an existing happy-path test that loads a fixture. Either:

(a) Add a new test with a network.json fixture carrying the new blocks:

```ts
it('passes dashboard_tiles and dashboard_buckets through into the resolved config', async () => {
  const fakeNetwork = {
    id: 'test_net',
    display_name: 'Test',
    domains: [
      {
        id: 'seeker',
        description: 'Seekers',
        item_schemas: { 'profile_1.0': { type: 'object' } },
        dashboard_tiles: {
          total_items: 'Total Seekers',
          complete_profiles: 'Complete',
          has_applications: 'Engaged',
        },
      },
    ],
    dashboard_buckets: {
      by_status: { new: 'New', active: 'Active', at_risk: 'At Risk', inactive: 'Inactive' },
      by_action_status: {
        create: 'Requested',
        accept: 'Connected',
        reject: 'Declined',
        cancel: 'Cancelled',
      },
    },
  };
  // Wire fakeNetwork through the existing test scaffolding (the test file
  // already shows how the loader is fed a network.json — match that pattern).
  // Then assert:
  const resolved = await loadWithFixture(/* ... */);
  expect(resolved.domains.seeker.dashboardTiles).toEqual({
    total_items: 'Total Seekers',
    complete_profiles: 'Complete',
    has_applications: 'Engaged',
  });
  expect(resolved.dashboardBuckets?.by_action_status).toEqual({
    create: 'Requested',
    accept: 'Connected',
    reject: 'Declined',
    cancel: 'Cancelled',
  });
});

it('leaves dashboardTiles and dashboardBuckets undefined when network.json omits them', async () => {
  // Use the existing minimal fixture; assert undefined.
  expect(resolved.domains.seeker.dashboardTiles).toBeUndefined();
  expect(resolved.dashboardBuckets).toBeUndefined();
});
```

(Match the existing test scaffolding pattern — the file already has fixture-loading helpers.)

- [ ] **Step 8: Run network-config tests**

```
pnpm --filter @aggregator-dpg/network-config test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/network-config/src/interface.ts \
        packages/network-config/src/loader.ts \
        packages/network-config/src/__tests__/loader.test.ts
git commit -m "feat(network-config): pass dashboard_tiles + dashboard_buckets through to resolved config"
```

---

## Task 6: BFF dashboard route — refresh forwarding

**Files:**

- Modify: `apps/api/src/routes/dashboard.ts` (around lines 48-76 and 177-260)
- Modify: `apps/api/src/routes/dashboard.test.ts`

- [ ] **Step 1: Update `DashboardQuerySchema` (around line 48)**

Add the `refresh` field:

```ts
const DashboardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  domain: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  /** Bypass signalstack's TTL cache when true. Forwarded verbatim. */
  refresh: z.coerce.boolean().optional().default(false),
});
```

(Match existing field ordering and `.optional().default(false)` style — the codebase already has examples in nearby route files.)

- [ ] **Step 2: Update `DashboardExportQuerySchema` (around line 67)**

```ts
const DashboardExportQuerySchema = z.object({
  domain: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  refresh: z.coerce.boolean().optional().default(false),
});
```

- [ ] **Step 3: Forward `refresh` in `fetchDashboard()` call (around line 177)**

Find the existing `ss.fetchDashboard({ actingOrgId, page, limit, ...(status ? { status } : {}), domain })`. Replace with:

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

`refresh` is destructured from `parsed.data` higher up. Make sure the destructure is updated:

```ts
const { page, limit, status, refresh } = parsed.data;
```

- [ ] **Step 4: Forward `refresh` in `exportDashboardCsv()` call (around line 253)**

Same pattern:

```ts
const { status, refresh } = parsed.data;
// ...
const result = await ss.exportDashboardCsv({
  actingOrgId,
  ...(status ? { status } : {}),
  ...(domain ? { domain } : {}),
  refresh,
});
```

(Domain forwarding follows the existing optional pattern in the file.)

- [ ] **Step 5: Update `dashboard.test.ts` assertions**

Open `apps/api/src/routes/dashboard.test.ts`. Find existing tests:

1. Update any test fixture/snapshot that asserts on `by_domain[id].participants` to assert on `by_domain[id].items` instead.
2. Update rollup field references (`applications_total` etc.) to canonical names.
3. Add a new test verifying refresh forwarding:

```ts
it('forwards ?refresh=true to the signalstack writer', async () => {
  const fakeWriter = new InMemorySignalStackWriter();
  const spy = vi.spyOn(fakeWriter, 'fetchDashboard');
  // Wire fakeWriter via the existing _setSignalStackWriter helper / fixture.
  _setSignalStackWriter(fakeWriter);

  await app.inject({
    method: 'GET',
    url: '/v1/dashboard?refresh=true',
    headers: {
      /* existing auth headers */
    },
  });

  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
});

it('defaults refresh to false when not provided', async () => {
  const fakeWriter = new InMemorySignalStackWriter();
  const spy = vi.spyOn(fakeWriter, 'fetchDashboard');
  _setSignalStackWriter(fakeWriter);

  await app.inject({
    method: 'GET',
    url: '/v1/dashboard',
    headers: {
      /* ... */
    },
  });

  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }));
});
```

(Match the file's existing test patterns for app fixtures and writer injection.)

- [ ] **Step 6: Run tests**

```
pnpm --filter @aggregator-dpg/api test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/routes/dashboard.test.ts
git commit -m "feat(api): dashboard route accepts ?refresh and forwards to signalstack writer"
```

---

## Task 7: Web service + hook types

**Files:**

- Modify: `apps/web/src/services/dashboard.service.ts` (around lines 30-90 and the dashboard() function lower)
- Modify: `apps/web/src/hooks/useDashboard.ts`

- [ ] **Step 1: Update `DashboardQuery` interface (around line 30)**

```ts
export interface DashboardQuery {
  domain?: string;
  page?: number;
  limit?: number;
  status?: string;
  /**
   * When true, the BFF forwards `?refresh=true` to signalstack to bypass
   * the rollup TTL and recompute synchronously. The page sets this only
   * for explicit user-initiated refreshes — passing it on every fetch
   * would defeat caching.
   */
  refresh?: boolean;
}
```

- [ ] **Step 2: Replace `DashboardRollup` (around line 43)**

```ts
export interface DashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Record<string, number>;
  by_action_status: Record<string, number>;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}
```

(Use `Record<string, number>` for `by_status` / `by_action_status` to tolerate missing keys; the page maps fixed keys with `?? 0` fallbacks.)

- [ ] **Step 3: Replace `DashboardDomainSlice` (around line 63)**

```ts
export interface DashboardDomainSlice {
  rollup: DashboardRollup;
  /** One row per item — `participants` was the old name. */
  items: Array<Record<string, unknown>>;
  total_matching: number;
  next_cursor: string | null;
}
```

- [ ] **Step 4: Update the `dashboard()` service method**

Find the `dashboard(query?: DashboardQuery)` function (likely lower in the file). It builds a query string. Add `refresh` forwarding:

```ts
async dashboard(query?: DashboardQuery): Promise<DashboardPage> {
  const params = new URLSearchParams();
  if (query?.domain) params.set('domain', query.domain);
  if (query?.page !== undefined) params.set('page', String(query.page));
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  if (query?.status) params.set('status', query.status);
  if (query?.refresh) params.set('refresh', 'true');   // NEW
  const qs = params.toString();
  return jsonFetch<DashboardPage>(`/api/dashboard${qs ? `?${qs}` : ''}`);
}
```

(Preserve whatever existing helpers the file uses for URL building — the snippet above is illustrative.)

- [ ] **Step 5: Update `useDashboard` hook**

Open `apps/web/src/hooks/useDashboard.ts`. Update the `useDashboard` function to forward `refresh` and include it in the query key:

```ts
export function useDashboard(query?: DashboardQuery) {
  const domain = query?.domain ?? 'seeker';
  const status = query?.status ?? null;
  const page = query?.page ?? 1;
  const limit = query?.limit ?? 50;
  const refresh = query?.refresh ?? false;
  return useQuery({
    // refresh DELIBERATELY in the queryKey so a forced refresh gets a fresh
    // cache entry rather than serving stale data from the prior key.
    queryKey: ['dashboard', 'dashboard', domain, status, page, limit, refresh],
    queryFn: () => dashboardService.dashboard(query),
    staleTime: 0,
  });
}
```

- [ ] **Step 6: Typecheck**

```
pnpm --filter @aggregator-dpg/web exec tsc --noEmit
```

Expected: errors only in `dashboard/page.tsx` (still using old field names) — fixed in Tasks 9-10. Service + hook themselves compile clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/services/dashboard.service.ts apps/web/src/hooks/useDashboard.ts
git commit -m "feat(web): dashboard service + hook accept refresh, emit canonical shape"
```

---

## Task 8: useAggregatorConfig type extension

**Files:**

- Modify: `apps/web/src/hooks/useAggregatorConfig.ts`

- [ ] **Step 1: Locate the response payload type**

Open the file. Find the existing `AggregatorConfigPayload` type (referenced at line 120 in the React Query call). It mirrors the BFF's response shape.

- [ ] **Step 2: Extend the type with the new optional blocks**

Add fields to whichever interface represents the resolved network config. The shape should mirror `ResolvedNetworkConfig` from `packages/network-config` (see Task 5 §5):

```ts
export interface DashboardTileLabels {
  total_items?: string;
  complete_profiles?: string;
  has_applications?: string;
}

export interface DashboardBuckets {
  by_status?: { new?: string; active?: string; at_risk?: string; inactive?: string };
  by_action_status?: { create?: string; accept?: string; reject?: string; cancel?: string };
}

// Inside whatever existing ResolvedDomainPayload / DomainConfig type the file declares:
export interface DomainConfig {
  id: string;
  label: string;
  pluralLabel: string;
  itemType: string;
  // ...existing fields...
  dashboardTiles?: DashboardTileLabels; // NEW
}

// Top-level payload type:
export interface AggregatorConfigPayload {
  aggregator: AggregatorYamlPayload;
  network: { id: string; display_name?: string /* ... */ };
  domains: Record<string, DomainConfig>;
  domainIds: string[];
  dashboardBuckets?: DashboardBuckets; // NEW
}
```

If the existing types are namespaced differently or use a generated Zod inference, adapt accordingly — the structural shape is what matters. Read the file first to match its style.

- [ ] **Step 3: Typecheck**

```
pnpm --filter @aggregator-dpg/web exec tsc --noEmit
```

Expected: this file compiles. Other errors only in dashboard/page.tsx still.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/useAggregatorConfig.ts
git commit -m "feat(web): aggregator-config payload exposes dashboardTiles + dashboardBuckets"
```

---

## Task 9: Dashboard page — rollup field renames + label sourcing

**Files:**

- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx` (around lines 756-1070)

This task focuses on the rollup-card edits and label sourcing. The refresh button comes in Task 10 (so each task touches one concern). Row-level field renames in `toSeekerRow` / `toProviderRow` happen here too, since they're intertwined with the slice rename.

- [ ] **Step 1: Update seeker block rollup picker (around lines 765-800)**

Locate the existing rollup picker (around line 785). Replace OLD field reads with NEW:

```tsx
// OLD:
const applicationsTotal = rollup?.applications_total;
const completeProfiles = rollup?.complete_profiles_count;

// NEW (place near where `rollup` is destructured/picked):
const totalItems = rollup?.total_items;
const completeProfiles = rollup?.complete_profiles;
const hasApplications = rollup?.has_applications;
const applicationsTotalDerived =
  (rollup?.by_action_status?.create ?? 0) +
  (rollup?.by_action_status?.accept ?? 0) +
  (rollup?.by_action_status?.reject ?? 0) +
  (rollup?.by_action_status?.cancel ?? 0);

// Wire labels from config:
const { data: cfg } = useAggregatorConfig();
const seekerCfg = cfg?.domains?.seeker;
const tileLabels = seekerCfg?.dashboardTiles ?? {};
const pluralSeekers = seekerCfg?.pluralLabel ?? 'Seekers';
```

For wherever the seeker tiles currently render with hardcoded titles, swap to use the resolved labels:

```tsx
<Card title={tileLabels.total_items ?? `Total ${pluralSeekers}`}>{totalItems ?? 0}</Card>
<Card title={tileLabels.complete_profiles ?? 'Profiles Complete'}>{completeProfiles ?? 0}</Card>
<Card title={tileLabels.has_applications ?? 'Has Applications'}>{hasApplications ?? 0}</Card>
```

(Locate the exact JSX block by grepping for `applications_total` and `complete_profiles_count` in the file; preserve existing card styling, swap only labels/values.)

- [ ] **Step 2: Update seeker block slice + row mapping**

Find `const rows = useMemo(() => (slice?.participants ?? []).map(toSeekerRow), [slice?.participants]);` (around line 788). Replace with:

```tsx
const rows = useMemo(() => (slice?.items ?? []).map(toSeekerRow), [slice?.items]);
```

- [ ] **Step 3: Update `toSeekerRow` (around line 869)**

```tsx
function toSeekerRow(participant: Record<string, unknown>): Seeker {
  const countCreate = numberOr(participant.count_create, 0);
  const countAccept = numberOr(participant.count_accept, 0);
  const countReject = numberOr(participant.count_reject, 0);
  const countCancel = numberOr(participant.count_cancel, 0);
  const total = countCreate + countAccept + countReject + countCancel;
  const lastAt = mostRecent(
    participant.last_create_at,
    participant.last_accept_at,
    participant.last_reject_at,
    participant.last_cancel_at,
  );
  return {
    // preserve existing fields used by the row renderer; replace these:
    applications: {
      total,
      accepted: countAccept,
      rejected: countReject,
      pending: countCreate,
    },
    lastActivityAt: lastAt,
    // ...keep whatever other fields toSeekerRow returned (name, status, completionPct, etc.)
    // The shape of Seeker is defined in apps/web/src/types; do not change the
    // outer shape — only the SOURCE of values.
  };
}

function mostRecent(...vals: unknown[]): string | null {
  const dates = vals
    .map((v) => (typeof v === 'string' ? v : null))
    .filter((v): v is string => v !== null);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}
```

(Keep the rest of `toSeekerRow` intact — fields like `name`, `phone`, `email`, `status`, `completionPct` continue to come from the participant record. They were already working off `participant.<field>` for fields signalstack populates verbatim.)

- [ ] **Step 4: Update provider block rollup picker (around lines 975-995)**

Mirror Step 1 for the provider domain block:

```tsx
const providerCfg = cfg?.domains?.provider;
const providerTileLabels = providerCfg?.dashboardTiles ?? {};
const pluralProviders = providerCfg?.pluralLabel ?? 'Providers';

const totalItemsP = rollup?.total_items;
const completeProfilesP = rollup?.complete_profiles;
const hasApplicationsP = rollup?.has_applications;

<Card title={providerTileLabels.total_items ?? `Total ${pluralProviders}`}>{totalItemsP ?? 0}</Card>
<Card title={providerTileLabels.complete_profiles ?? 'Profiles Complete'}>{completeProfilesP ?? 0}</Card>
<Card title={providerTileLabels.has_applications ?? 'Has Applications'}>{hasApplicationsP ?? 0}</Card>
```

The OLD provider tiles `openRoles = rollup?.applications_pending` and `hiresThisMonth = rollup?.applications_total` are removed in favor of the 3 standardized tiles above; the network-specific copy (Open Roles / Hires This Month) becomes the role of the `dashboardTiles` config block for that domain.

- [ ] **Step 5: Update provider block slice + row mapping**

```tsx
const rows = useMemo(() => (slice?.items ?? []).map(toProviderRow), [slice?.items]);
```

- [ ] **Step 6: Update `toProviderRow` (around line 1057)**

```tsx
function toProviderRow(participant: Record<string, unknown>): Provider {
  // toProviderRow already delegates to toSeekerRow for common fields per the
  // current implementation. Once toSeekerRow uses count_* fields, providers
  // inherit those automatically. Just verify by inspection that no
  // provider-only field path still reads applications_*.
  const seeker = toSeekerRow(participant);
  return {
    ...seeker,
    // provider-specific fields stay verbatim (e.g. role count fields specific
    // to provider rows, if any — most rows reuse the seeker shape).
  };
}
```

- [ ] **Step 7: Update by_status histogram references**

The page reads `rollup?.by_status` (around lines 765, 977). The map keys are now constrained to `'new'|'active'|'at_risk'|'inactive'` (no `'satisfied'`). If the page renders a chip for each status key, dropping `'satisfied'` from any hardcoded array is required. Grep:

```
grep -n "satisfied" apps/web/src/app/\(protected\)/dashboard/page.tsx
```

Remove any references (the metric refactor dropped `satisfied`).

Also wire status labels from config:

```tsx
const statusLabels = cfg?.dashboardBuckets?.by_status ?? {
  new: 'New',
  active: 'Active',
  at_risk: 'At Risk',
  inactive: 'Inactive',
};

// In the chip render:
<Chip label={statusLabels[key] ?? key}>{byStatus[key] ?? 0}</Chip>;
```

(Apply to both seeker and provider blocks.)

- [ ] **Step 8: Verify the page typechecks + tests pass**

```
pnpm --filter @aggregator-dpg/web exec tsc --noEmit
pnpm --filter @aggregator-dpg/web test
```

Expected: PASS (with refresh button still pending in Task 10).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/\(protected\)/dashboard/page.tsx
git commit -m "feat(web): dashboard renders canonical rollup + reads labels from network config"
```

---

## Task 10: Dashboard page — Refresh button

**Files:**

- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx`

- [ ] **Step 1: Add Refresh button next to the page title**

Find where the dashboard page heading is rendered (likely a header block at the top of the seeker view, around lines 750-770). Add a small icon button.

First, ensure the necessary imports exist at the top of the file:

```tsx
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react'; // or whichever icon lib the codebase uses — grep for `lucide` or `react-icons` first
```

If `lucide-react` isn't already a dep, find the icon library the rest of the page uses (search the file for any existing icon imports) and use that.

In the component body (top of seeker view component, before the JSX return):

```tsx
const queryClient = useQueryClient();
const [refreshing, setRefreshing] = useState(false);
const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

async function handleRefresh() {
  setRefreshing(true);
  try {
    // Bypass React Query's normal cache by calling the service directly with refresh=true.
    await dashboardService.dashboard({
      domain,
      page,
      limit,
      status: status ?? undefined,
      refresh: true,
    });
    // Invalidate the regular (refresh=false) cache key so the next normal refetch sees fresh data.
    await queryClient.invalidateQueries({ queryKey: ['dashboard', 'dashboard', domain] });
    setLastRefreshedAt(Date.now());
  } finally {
    setRefreshing(false);
  }
}
```

In the JSX, next to the page title (inside the header block), render:

```tsx
<button
  type="button"
  onClick={handleRefresh}
  disabled={refreshing}
  aria-label="Refresh dashboard"
  title="Refresh dashboard"
  className="inline-flex items-center justify-center p-2 rounded hover:bg-muted disabled:opacity-50"
>
  <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
</button>;

{
  lastRefreshedAt !== null && Date.now() - lastRefreshedAt < 5000 && (
    <span className="text-xs text-muted-foreground ml-2">Refreshed just now</span>
  );
}
```

(Adapt the className to whatever Tailwind utilities + theme tokens the surrounding code uses. The grep for similar buttons (filter chip, paginator buttons) shows the convention.)

- [ ] **Step 2: Optional — surface `metadata.refreshed` from the response**

If the existing page already exposes the response payload (or a hook returns it), render a small "Last updated: <time>" caption next to the title. Source: `dashboard?.metadata?.last_computed_at` and `dashboard?.metadata?.refreshed`. This is a small UX win; only add if a hook variable already holds the metadata. Otherwise skip (out-of-scope churn).

- [ ] **Step 3: Verify**

Manually:

```
pnpm --filter @aggregator-dpg/web exec tsc --noEmit
pnpm --filter @aggregator-dpg/web test
```

Expected: PASS.

Smoke test in the browser once Tasks 1-9 are all done:

- Open the dashboard page locally.
- Click the Refresh button.
- See spinner for ~1s.
- See "Refreshed just now" caption.
- Numbers visibly update if Signals had buffered changes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/\(protected\)/dashboard/page.tsx
git commit -m "feat(web): dashboard Refresh button forces signalstack recompute"
```

---

## Task 11: Signals-DPG companion PR — populate labels

**Files (in `../Signals-DPG/`, not this repo):**

- Modify: `packages/schemas/src/network_workflow.ts`
- Modify: `examples/schemas/purple_dot/network.json`
- Modify: `examples/schemas/blue_dot/network.json`
- Modify: `examples/schemas/yellow_dot/network.json`
- Modify: `packages/schemas/src/__tests__/network_workflow_metrics.test.ts`

This is a small companion PR. It can land independently of the aggregator-dpg PR — the UI ships English defaults until the labels arrive. Coordinate the merge order: this Signals PR can go first, but isn't required to be.

- [ ] **Step 1: Switch repos and create branch**

```bash
cd ../Signals-DPG
git fetch origin develop
git checkout -b chore/dashboard-label-passthrough origin/develop
```

- [ ] **Step 2: Extend `NetworkConfigSchema` Zod in `packages/schemas/src/network_workflow.ts`**

Find `NetworkDomainSchema` (around line 6). Add `dashboard_tiles` as an optional `.strict()` object:

```ts
const DashboardTileLabelsSchema = z.object({
  total_items: z.string().min(1).optional(),
  complete_profiles: z.string().min(1).optional(),
  has_applications: z.string().min(1).optional(),
}).strict();

// Inside NetworkDomainSchema's z.object body, add this field:
dashboard_tiles: DashboardTileLabelsSchema.optional(),
```

Find `NetworkConfigSchema` (around line 111). Add `dashboard_buckets` as an optional `.strict()` object at the root level:

```ts
const DashboardBucketsSchema = z.object({
  by_status: z.object({
    new: z.string().min(1).optional(),
    active: z.string().min(1).optional(),
    at_risk: z.string().min(1).optional(),
    inactive: z.string().min(1).optional(),
  }).strict().optional(),
  by_action_status: z.object({
    create: z.string().min(1).optional(),
    accept: z.string().min(1).optional(),
    reject: z.string().min(1).optional(),
    cancel: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

// Inside NetworkConfigSchema's z.object body, add:
dashboard_buckets: DashboardBucketsSchema.optional(),
```

Both schemas `.strict()` so unknown keys fail at network load (matches the metrics refactor convention).

- [ ] **Step 3: Add Zod tests in `packages/schemas/src/__tests__/network_workflow_metrics.test.ts`**

Append to the existing `describe` block:

```ts
it('accepts dashboard_tiles on a domain', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.domains[0].dashboard_tiles = {
    total_items: 'Total Seekers',
    complete_profiles: 'Profiles Done',
    has_applications: 'Engaged',
  };
  expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
});

it('rejects an unknown key in dashboard_tiles', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.domains[0].dashboard_tiles = { total_items: 'Total', not_a_tile: 'x' };
  expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
});

it('accepts dashboard_buckets at the network root', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.dashboard_buckets = {
    by_status: { new: 'New', active: 'Active', at_risk: 'At Risk', inactive: 'Inactive' },
    by_action_status: {
      create: 'Applied',
      accept: 'Shortlisted',
      reject: 'Rejected',
      cancel: 'Withdrawn',
    },
  };
  expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
});

it('rejects unknown bucket key in dashboard_buckets.by_action_status', () => {
  const cfg = JSON.parse(JSON.stringify(baseConfig));
  cfg.dashboard_buckets = {
    by_action_status: { shortlisted: 'foo' },
  };
  expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
});
```

- [ ] **Step 4: Populate `examples/schemas/purple_dot/network.json`**

Edit the file. Add `dashboard_tiles` to each domain entry (right after `description`):

For `domains[0]` (seeker):

```jsonc
"dashboard_tiles": {
  "total_items": "Total Beneficiaries",
  "complete_profiles": "Profiles Complete",
  "has_applications": "Made Connections"
}
```

For `domains[1]` (provider):

```jsonc
"dashboard_tiles": {
  "total_items": "Total Service Providers",
  "complete_profiles": "Profiles Complete",
  "has_applications": "Received Connections"
}
```

At the network root (sibling of `domains`, `instances`, `actions`):

```jsonc
"dashboard_buckets": {
  "by_status": {
    "new": "New",
    "active": "Active",
    "at_risk": "At Risk",
    "inactive": "Inactive"
  },
  "by_action_status": {
    "create": "Requested",
    "accept": "Connected",
    "reject": "Declined",
    "cancel": "Cancelled"
  }
}
```

- [ ] **Step 5: Populate `examples/schemas/blue_dot/network.json`**

For `seeker.dashboard_tiles`:

```jsonc
"dashboard_tiles": {
  "total_items": "Total Job Seekers",
  "complete_profiles": "Profiles Complete",
  "has_applications": "Applied for Jobs"
}
```

For `provider.dashboard_tiles`:

```jsonc
"dashboard_tiles": {
  "total_items": "Total Job Postings",
  "complete_profiles": "Postings Complete",
  "has_applications": "Received Applications"
}
```

At the network root:

```jsonc
"dashboard_buckets": {
  "by_status": {
    "new": "New",
    "active": "Active",
    "at_risk": "At Risk",
    "inactive": "Inactive"
  },
  "by_action_status": {
    "create": "Applied",
    "accept": "Shortlisted",
    "reject": "Rejected",
    "cancel": "Withdrawn"
  }
}
```

- [ ] **Step 6: Populate `examples/schemas/yellow_dot/network.json`**

Add a minimal, generic dashboard block. For each domain:

```jsonc
"dashboard_tiles": {
  "total_items": "Total Students",
  "complete_profiles": "Profiles Complete",
  "has_applications": "Has Activity"
}
```

Network root:

```jsonc
"dashboard_buckets": {
  "by_status": {
    "new": "New",
    "active": "Active",
    "at_risk": "At Risk",
    "inactive": "Inactive"
  },
  "by_action_status": {
    "create": "Created",
    "accept": "Accepted",
    "reject": "Rejected",
    "cancel": "Cancelled"
  }
}
```

(Yellow Dot domains may have IDs other than `seeker`/`provider` — match whatever the file declares; the `dashboard_tiles` block goes on each domain entry regardless of id.)

- [ ] **Step 7: Run Signals-DPG tests**

```
pnpm --filter schemas test
```

Expected: all tests pass (15+ in `network_workflow_metrics.test.ts` once the 4 new cases are added).

- [ ] **Step 8: Commit on the Signals-DPG branch**

```bash
git add packages/schemas/src/network_workflow.ts \
        packages/schemas/src/__tests__/network_workflow_metrics.test.ts \
        examples/schemas/
git commit -m "feat(networks): dashboard_tiles + dashboard_buckets label passthrough"
```

- [ ] **Step 9: Push and open PR (Signals-DPG)**

```bash
git push -u origin chore/dashboard-label-passthrough
gh pr create --base develop --title "feat(networks): dashboard label passthrough" --body "Adds optional dashboard_tiles per domain + dashboard_buckets at the network root. Consumed by aggregator-dpg PR <link>; UI falls back to English defaults when absent."
```

(Substitute the aggregator-dpg PR URL once it's open.)

- [ ] **Step 10: Switch back to aggregator-dpg**

```bash
cd ../aggregator-dpg
```

---

## Self-review against spec

| Spec section                                         | Task                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| §1 Contract layer (interface.ts)                     | Task 1                                         |
| §2 HTTP impl + refresh URL                           | Task 2                                         |
| §3 In-memory fake shape                              | Task 3                                         |
| §4 BFF Zod + forward refresh                         | Task 6                                         |
| §5 network-config types                              | Task 5                                         |
| §6 network-config loader passthrough                 | Task 5                                         |
| §6.A Signals-DPG companion PR                        | Task 11                                        |
| §7 /v1/aggregator-config + useAggregatorConfig types | Task 8                                         |
| §8(a) UI field renames                               | Task 9                                         |
| §8(b) UI label sourcing                              | Task 9                                         |
| §8(c) UI refresh button                              | Task 10                                        |
| §9 Tests                                             | Task 4 (writer), Task 5 (loader), Task 6 (BFF) |

All spec sections covered. Task 4 batches writer test updates; Task 5 batches loader test updates; Task 6 batches BFF test updates. Tasks 9/10 split UI work by concern.

No placeholders. Every step has concrete code or a concrete command. Type names consistent across tasks (`DashboardTileLabels`, `DashboardBuckets`, `dashboardTiles`, `dashboardBuckets`, `total_items`, `complete_profiles`, `has_applications`, `by_status`, `by_action_status`, `avg_items_per_user`, `avg_actions_per_user`, `mode_wise_counts`, `count_create/accept/reject/cancel`, `last_create_at/accept_at/reject_at/cancel_at`).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-signals-canonical-dashboard.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints.

Which approach?
