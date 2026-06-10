# User-Level Metrics + Directional Action Columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the aggregator dashboard read signalstack's enriched payload — directional (`initiated` / `received`) action counts plus user-level rollup numbers — and render two config-driven tile groups (profile-level + user-level) and two action column groups, with no metric name hardcoded.

**Architecture:** Signalstack owns all computation (separate `Signals-DPG` repo — see Part 0 checklist). This repo (`aggregator-dpg`) is display-only: it updates the read contracts, threads new fields through the BFF, extends `network.json` passthrough types, and rewrites the two dashboard sections to be config-driven. The bottom table stays one-row-per-profile keyed by `profile_item_id`; the top summary renders profile + user tile groups from rollup keys named in config.

**Tech Stack:** TypeScript, pnpm + Turbo monorepo, Vitest, Fastify (api), Next.js 15 App Router (web), Zod, abstract-class service contracts with `./testing` fakes.

**Spec:** `docs/superpowers/specs/2026-06-07-user-level-metrics-directional-actions-design.md`

**Conventions (from `.claude/rules/`):**

- Cross-package contracts are `abstract class` + Zod; consumers import `./interface` / `./testing` only.
- Fakes extend the in-memory impl and expose `seed()` + builders. No `vi.mock()` of interfaces.
- Tests in `src/__tests__/`; ≥70% line coverage; no real network/DB.
- Run `pnpm dep-check` before pushing. Conventional Commits; never `--no-verify`.
- Branch already created: `feat/user-level-metrics-directional-actions`. Commit per task.

---

## Part 0 — Signalstack prerequisite (separate `Signals-DPG` repo — NOT this plan)

> Hand to the signalstack team. The aggregator work below is independently testable against fixtures, but production needs these shipped first (hard cutover — flat `count_*` removed).
>
> **Merge gate:** the aggregator PR (Task G1) must NOT merge to `develop` until this signalstack payload is deployed and verified in the target env. The aggregator survives the gap (defensive `?? 0`) but renders wrong/zero data until then — the gate enforces correctness, not the code.

- [ ] Add `profile_item_id` (required) + `user_id` (optional) to each `by_domain[*].items[]` row.
- [ ] Replace flat `count_*` / `last_*_at` per item with `initiated`, `received`, `last_initiated_at`, `last_received_at` (each a `{create,accept,reject,cancel}` map; `last_*` values are ISO string or null).
- [ ] Rollup: remove `by_action_status`; add `by_initiated_action_status`, `by_received_action_status`, `total_users`, `users_with_applications`, `new_users_7d` (keep `avg_items_per_user`, `avg_actions_per_user`).
- [ ] Update each network's `network.json` with `dashboard_tiles.{profile,user}` + `dashboard_buckets.{by_initiated_action_status,by_received_action_status}` (see Part F for the shape the aggregator expects).
- [ ] Update the dashboard CSV export columns to match (drop `count_*`; add directional columns + `profile_item_id`).

---

## File Structure (this repo)

| File                                                              | Responsibility                   | Change                                                                             |
| ----------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/signalstack-writer/src/interface.ts`                    | dashboard read contract          | rollup fields; item-keys doc comment                                               |
| `packages/signalstack-writer/src/memory.ts`                       | in-memory fake dashboard payload | new rollup + item shape                                                            |
| `packages/signalstack-writer/src/__tests__/{http,memory}.test.ts` | contract fixtures                | new shape                                                                          |
| `packages/network-config/src/interface.ts`                        | `network.json` passthrough types | new tile-group + directional bucket types                                          |
| `packages/network-config/src/__tests__/loader.test.ts`            | loader passthrough               | new fields                                                                         |
| `apps/api/src/routes/aggregator-config.ts`                        | serialize config to web          | type updates (passthrough)                                                         |
| `apps/api/src/routes/dashboard.ts` + `.test.ts`                   | BFF proxy + CSV                  | verify passthrough; CSV header expectations                                        |
| `apps/web/src/services/dashboard.service.ts`                      | rollup type + row mapping        | drop `by_action_status`; add fields; row id → `profile_item_id`; directional split |
| `apps/web/src/types/index.ts`                                     | row view-model                   | directional `initiated`/`received` stats                                           |
| `apps/web/src/hooks/useAggregatorConfig.ts`                       | web config types                 | tile-group + directional bucket types                                              |
| `apps/web/src/app/(protected)/dashboard/page.tsx`                 | the two sections                 | config-driven tiles; two action columns                                            |

---

## Part A — Read contract (`packages/signalstack-writer`)

### Task A1: Rollup contract — directional + user-level fields

**Files:**

- Modify: `packages/signalstack-writer/src/interface.ts:211-234`

- [ ] **Step 1: Edit the rollup interface.** Replace the `SignalStackDashboardRollup` body (currently lines 211-220):

```typescript
export interface SignalStackDashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', number>>;
  /** Actions this domain's profiles INITIATED, by action state. */
  by_initiated_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Actions this domain's profiles RECEIVED, by action state. */
  by_received_action_status: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', number>>;
  /** Distinct users (one user may own many profiles). */
  total_users: number;
  /** Distinct users with ≥1 application across their profiles. */
  users_with_applications: number;
  /** Distinct users whose earliest profile is ≤7 days old. */
  new_users_7d: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}
```

- [ ] **Step 2: Update the item-keys doc comment** on `SignalStackDashboardDomainSlice.items` (lines 228-233) to:

```typescript
/**
 * One row per profile. Open-shape because signalstack owns the per-row
 * schema; consumers decode the keys they care about (today:
 * profile_item_id, user_id, name, item_network, item_type, onboarded_via,
 * profile_status, profile_completion_pct, profile_created_at,
 * profile_last_updated_at, age_days, initiated, received,
 * last_initiated_at, last_received_at, actionable_tags).
 */
```

- [ ] **Step 3: Typecheck the package.**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer typecheck`
Expected: PASS for the interface; the memory impl/tests may now fail to compile — fixed in Task A2.

- [ ] **Step 4: Commit.**

```bash
git add packages/signalstack-writer/src/interface.ts
git commit -m "feat(signalstack-writer): directional + user-level rollup contract"
```

### Task A2: Memory fake + fixtures to the new shape

**Files:**

- Modify: `packages/signalstack-writer/src/memory.ts` (dashboard rollup/item construction)
- Modify: `packages/signalstack-writer/src/__tests__/http.test.ts:63-167` (CANONICAL_DASHBOARD_PAYLOAD)
- Modify: `packages/signalstack-writer/src/__tests__/memory.test.ts:370-400` (item fixture)

- [ ] **Step 1: Find the rollup/item builders in the fake.**

Run: `grep -n "by_action_status\|count_create\|by_status\|avg_items_per_user\|items:" packages/signalstack-writer/src/memory.ts`
Expected: locate where the fake assembles `rollup` and item rows.

- [ ] **Step 2: Update the fake's rollup** to emit the new keys. Replace any `by_action_status: {...}` with both directional maps and add the three user-level fields, e.g.:

```typescript
by_initiated_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
by_received_action_status: { create: 0, accept: 0, reject: 0, cancel: 0 },
total_users: this.store.size,
users_with_applications: 0,
new_users_7d: 0,
```

(Derive `total_users` from distinct `user_id`s the fake holds if it tracks them; otherwise `this.store.size` is an acceptable fake value.)

- [ ] **Step 3: Update the fake's item rows** — drop `count_*` / `last_*_at`; add:

```typescript
profile_item_id: item.item_id,
user_id: item.user_id ?? '',
initiated: { create: 0, accept: 0, reject: 0, cancel: 0 },
received: { create: 0, accept: 0, reject: 0, cancel: 0 },
last_initiated_at: { create: null, accept: null, reject: null, cancel: null },
last_received_at: { create: null, accept: null, reject: null, cancel: null },
```

- [ ] **Step 4: Update `http.test.ts` CANONICAL_DASHBOARD_PAYLOAD** — in the `rollup`, replace `by_action_status` with the two directional maps and add `total_users: 4, users_with_applications: 3, new_users_7d: 1`. In the single item, drop `count_*` / `last_*_at` and add `profile_item_id: 'p-abc'`, `user_id: 'u-123'`, plus the `initiated`/`received`/`last_initiated_at`/`last_received_at` maps (use the §1.4 example values). Update the assertion at `http.test.ts:371` (`expect(item['count_create']).toBe(1)`) to `expect((item['initiated'] as Record<string, number>)['create']).toBe(1)`.

- [ ] **Step 5: Update `memory.test.ts:370-400`** the seeded item fixture identically (drop `count_*`, add directional + ids). Adjust any assertion referencing `count_*` or `by_action_status`.

- [ ] **Step 6: Run the package tests.**

Run: `pnpm --filter @aggregator-dpg/signalstack-writer test`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/signalstack-writer/src
git commit -m "test(signalstack-writer): fakes + fixtures to directional/user-level shape"
```

---

## Part B — `network.json` passthrough types (`packages/network-config`)

### Task B1: Tile-group + directional bucket types

**Files:**

- Modify: `packages/network-config/src/interface.ts:196-210`
- Test: `packages/network-config/src/__tests__/loader.test.ts`

- [ ] **Step 1: Replace `DashboardTileLabels` (lines 196-200)** with a tile-definition list grouped by metric level:

```typescript
/**
 * One dashboard tile: which rollup key to read and what to call it.
 * `field` is a key on the signalstack rollup (e.g. `total_users`,
 * `complete_profiles`). The aggregator reads the precomputed value — it
 * never aggregates. Unknown `field` → tile skipped (logged `warn`).
 */
export interface DashboardTileDef {
  field: string;
  label: string;
}

/**
 * Per-domain dashboard tiles, split into profile-level and user-level
 * groups. Both optional — UI falls back to default English tiles when a
 * group is absent. Carried verbatim from `network.json`.
 */
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
}
```

- [ ] **Step 2: Replace `DashboardBuckets` (lines 207-210)** with directional action maps:

```typescript
export interface DashboardBuckets {
  by_status?: Partial<Record<'new' | 'active' | 'at_risk' | 'inactive', string>>;
  by_initiated_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
  by_received_action_status?: Partial<Record<'create' | 'accept' | 'reject' | 'cancel', string>>;
}
```

- [ ] **Step 3: Update the three references to the renamed type.** `NetworkDomain.dashboard_tiles` (line 235) and `ResolvedDomain.dashboardTiles` (line 283) change type `DashboardTileLabels` → `DashboardTiles`. The loader passthrough at `loader.ts:318` (`dashboardTiles: d.dashboard_tiles`) needs no logic change — it copies through. Confirm:

Run: `grep -rn "DashboardTileLabels" packages/network-config/src`
Expected: no matches remain (all renamed to `DashboardTiles`).

- [ ] **Step 4: Add a loader test** in `loader.test.ts`. Seed an injected network with the new blocks and assert passthrough:

```typescript
it('passes through tile groups and directional buckets', async () => {
  const cfg = await loadWithNetwork({
    id: 'blue_dot',
    domains: [
      {
        id: 'seeker',
        item_schemas: { 'profile_1.0': {} },
        dashboard_tiles: {
          profile: [{ field: 'total_items', label: 'Profiles' }],
          user: [{ field: 'total_users', label: 'Total Seekers' }],
        },
      },
    ],
    dashboard_buckets: {
      by_initiated_action_status: { create: 'Applied' },
      by_received_action_status: { create: 'Requests' },
    },
  });
  expect(cfg.domains['seeker']!.dashboardTiles?.user?.[0]).toEqual({
    field: 'total_users',
    label: 'Total Seekers',
  });
  expect(cfg.dashboardBuckets?.by_initiated_action_status?.create).toBe('Applied');
});
```

(Use the existing test helper for injecting a network — check the top of `loader.test.ts` for the `InMemoryNetworkConfigLoader` / injection helper and mirror its call shape; name it `loadWithNetwork` only if no equivalent exists.)

- [ ] **Step 5: Run tests + dep-check.**

Run: `pnpm --filter @aggregator-dpg/network-config test && pnpm dep-check`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/network-config/src
git commit -m "feat(network-config): tile-group + directional bucket passthrough types"
```

---

## Part C — API layer (`apps/api`)

### Task C1: aggregator-config route — type updates (passthrough)

**Files:**

- Modify: `apps/api/src/routes/aggregator-config.ts:23-24,64`

- [ ] **Step 1: Update the imported type name.** Change the import (line 24) `DashboardTileLabels` → `DashboardTiles`, and the `domains[].dashboardTiles` field type (line 64) to `DashboardTiles`. The serialization at lines 110/114 is already a spread passthrough — no logic change.

- [ ] **Step 2: Typecheck.**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add apps/api/src/routes/aggregator-config.ts
git commit -m "refactor(api): aggregator-config uses DashboardTiles type"
```

### Task C2: dashboard route — verify passthrough + CSV expectations

**Files:**

- Modify: `apps/api/src/routes/dashboard.test.ts` (CSV header expectations, line ~470)
- Inspect: `apps/api/src/routes/dashboard.ts`

- [ ] **Step 1: Confirm the proxy is field-agnostic.**

Run: `grep -n "by_action_status\|count_create\|pick\|whitelist\|z.object" apps/api/src/routes/dashboard.ts`
Expected: no field whitelist on the rollup/items (it forwards the signalstack payload). If a Zod response schema pins `by_action_status`, update it to the directional keys + new user-level fields (mirror Task A1). If nothing pins it, no change.

- [ ] **Step 2: Update the CSV test fixture** at `dashboard.test.ts:470`. The header `user_id,profile_status,profile_completion_pct` is owned by signalstack; align the expected header string to whatever the export now returns (at minimum it still carries `profile_status,profile_completion_pct`). If the test asserts the full CSV verbatim, update it to include `profile_item_id` and drop any `count_*` columns.

- [ ] **Step 3: Run api tests.**

Run: `pnpm --filter @aggregator-dpg/api test`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/routes/dashboard.test.ts
git commit -m "test(api): dashboard CSV expectations for enriched payload"
```

---

## Part D — Web data mapping (`apps/web/src/services` + types)

### Task D1: `DashboardRollup` view type

**Files:**

- Modify: `apps/web/src/services/dashboard.service.ts:44-58`

- [ ] **Step 1: Replace the `DashboardRollup` interface** (lines 50-58). Drop `by_action_status`; add the directional + user-level fields (open `Record` for defensive `?? 0` reads, matching the existing convention):

```typescript
export interface DashboardRollup {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  by_status: Record<string, number>;
  by_initiated_action_status: Record<string, number>;
  by_received_action_status: Record<string, number>;
  total_users: number;
  users_with_applications: number;
  new_users_7d: number;
  avg_items_per_user: number;
  avg_actions_per_user: number;
  mode_wise_counts: Record<string, number>;
}
```

- [ ] **Step 2: Typecheck web.**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: FAIL in `page.tsx` (references `by_action_status`) — fixed in Part F. The service file itself compiles.

- [ ] **Step 3: Commit.**

```bash
git add apps/web/src/services/dashboard.service.ts
git commit -m "feat(web): dashboard rollup view type — directional + user-level"
```

### Task D2: Row view-model + row mapping (id → profile_item_id, directional stats)

**Files:**

- Modify: `apps/web/src/types/index.ts:1-45`
- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx:1122-1172` (`toSeekerRow`), `:1418-1421` (`toProviderRow`)

- [ ] **Step 1: Add a directional stats shape to the view-model.** In `types/index.ts`, keep `ParticipantStats` (the existing `applied` shape) and add a directional container on `ParticipantBase`:

```typescript
/** One direction's action counts, keyed by canonical action state. */
export interface DirectionalStats {
  create: number;
  accept: number;
  reject: number;
  cancel: number;
}

// add to ParticipantBase (alongside `applied`):
//   initiated: DirectionalStats;
//   received: DirectionalStats;
```

Edit `ParticipantBase` to include `initiated: DirectionalStats;` and `received: DirectionalStats;`.

- [ ] **Step 2: Write a failing test** for the mapping. Create `apps/web/src/services/__tests__/toRow.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapDirectional } from '../row-mapping';

describe('mapDirectional', () => {
  it('reads a directional action map with zero fallback', () => {
    expect(mapDirectional({ create: 2, accept: 1 })).toEqual({
      create: 2,
      accept: 1,
      reject: 0,
      cancel: 0,
    });
  });
  it('returns all-zero for missing map', () => {
    expect(mapDirectional(undefined)).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
  });
});
```

- [ ] **Step 3: Run it — must fail.**

Run: `pnpm --filter @aggregator-dpg/web test -- src/services/__tests__/toRow.test.ts`
Expected: FAIL ("Cannot find module '../row-mapping'").

- [ ] **Step 4: Create `apps/web/src/services/row-mapping.ts`** with the pure helper (extracted so it is unit-testable without React):

```typescript
import type { DirectionalStats } from '../types';

/**
 * Coerces a signalstack directional action map into a complete
 * {@link DirectionalStats}, defaulting every missing bucket to 0.
 *
 * @param raw - `initiated` / `received` map from a dashboard item, or undefined.
 * @returns A fully-populated directional stats object.
 */
export function mapDirectional(raw: unknown): DirectionalStats {
  const m = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    create: num(m.create),
    accept: num(m.accept),
    reject: num(m.reject),
    cancel: num(m.cancel),
  };
}
```

- [ ] **Step 5: Run the test — must pass.**

Run: `pnpm --filter @aggregator-dpg/web test -- src/services/__tests__/toRow.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire mapping into `toSeekerRow` + thread the row index.** The current row `id` chain is `owner_user_id → user_id → ''` (page.tsx:1123-1143). Per the locked decision the new key is **`profile_item_id`, else the array index** — `owner_user_id`/`user_id` are dropped from the key (keep `user_id` as a separate optional field only). The index fallback needs a signature change:
  - Change the signature to `toSeekerRow(participant: Record<string, unknown>, locale: string, index: number)`.
  - Update both call sites — `page.tsx:947` and `page.tsx:1263` — from `.map((p) => toSeekerRow(p, locale))` / `toProviderRow(p, locale)` to `.map((p, i) => toSeekerRow(p, locale, i))` / `toProviderRow(p, locale, i)`.
  - Update `toProviderRow` (page.tsx:1418-1419) to accept `index` and forward it: `const seeker = toSeekerRow(participant, locale, index);`.

```typescript
const profileItemId =
  typeof participant.profile_item_id === 'string' ? participant.profile_item_id : '';
const userId = typeof participant.user_id === 'string' ? participant.user_id : '';
// ...
return {
  id: profileItemId || String(index), // row key — profile_item_id, else array index
  initiated: mapDirectional(participant.initiated),
  received: mapDirectional(participant.received),
  // ...existing fields (name, city, joined, avatar, profile, applied, status, last)...
};
```

Import `mapDirectional` at the top of `page.tsx`. Leave the existing `applied` mapping in place for now (table swap happens in Part F). Add a `mapDirectional`/index unit-test case for the missing-`profile_item_id` → index path.

- [ ] **Step 7: Run web tests (mapping green; page may still fail typecheck until Part F).**

Run: `pnpm --filter @aggregator-dpg/web test -- src/services/__tests__/toRow.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/types/index.ts apps/web/src/services/row-mapping.ts apps/web/src/services/__tests__/toRow.test.ts "apps/web/src/app/(protected)/dashboard/page.tsx"
git commit -m "feat(web): row keyed by profile_item_id + directional stats mapping"
```

---

## Part E — Web config types (`apps/web/src/hooks`)

### Task E1: Mirror tile-group + directional bucket types

**Files:**

- Modify: `apps/web/src/hooks/useAggregatorConfig.ts:21-44,61`

- [ ] **Step 1: Replace `DashboardTileLabels` (lines 21-25)** with the tile-group shape (plain TS, mirrors `network-config`):

```typescript
export interface DashboardTileDef {
  field: string;
  label: string;
}
export interface DashboardTiles {
  profile?: DashboardTileDef[];
  user?: DashboardTileDef[];
}
```

- [ ] **Step 2: Replace `DashboardBuckets` (lines 31-44)** with directional maps:

```typescript
export interface DashboardBuckets {
  by_status?: { new?: string; active?: string; at_risk?: string; inactive?: string };
  by_initiated_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
  by_received_action_status?: {
    create?: string;
    accept?: string;
    reject?: string;
    cancel?: string;
  };
}
```

- [ ] **Step 3: Update `AggregatorConfigDomain.dashboardTiles` (line 61)** type `DashboardTileLabels` → `DashboardTiles`.

- [ ] **Step 4: Typecheck.**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: still FAILs only in `page.tsx` tile/bucket usage — fixed next in Part F.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/hooks/useAggregatorConfig.ts
git commit -m "feat(web): config types for tile groups + directional buckets"
```

---

## Part F — Web UI: two tile groups + two action columns (`page.tsx`)

### Task F1: Config-driven top summary (profile + user tile groups)

**Files:**

- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx:1053-1077` (seeker MiniStat block) and the matching provider block (~1375-1393)

- [ ] **Step 1: Add a config-driven tile helper** near the other module helpers in `page.tsx`:

```typescript
import type { DashboardTileDef } from '../../../hooks/useAggregatorConfig';
import type { DashboardRollup } from '../../../services/dashboard.service';

const DEFAULT_PROFILE_TILES: DashboardTileDef[] = [
  { field: 'total_items', label: 'Total Profiles' },
  { field: 'complete_profiles', label: 'Complete Profiles' },
  { field: 'has_applications', label: 'Profiles with Applications' },
];
const DEFAULT_USER_TILES: DashboardTileDef[] = [
  { field: 'total_users', label: 'Total Users' },
  { field: 'avg_items_per_user', label: 'Avg Profiles per User' },
  { field: 'users_with_applications', label: 'Users with Applications' },
  { field: 'new_users_7d', label: 'New Users (7d)' },
];

/**
 * Resolves tile defs from config, falling back to defaults, and reads each
 * tile's value from the rollup by `field`. Unknown fields render as 0.
 */
function resolveTiles(
  defs: DashboardTileDef[] | undefined,
  fallback: DashboardTileDef[],
  rollup: DashboardRollup | undefined,
): Array<{ label: string; value: number }> {
  return (defs && defs.length ? defs : fallback).map((d) => ({
    label: d.label,
    value: rollup ? ((rollup as unknown as Record<string, number>)[d.field] ?? 0) : 0,
  }));
}
```

- [ ] **Step 2: Replace the hardcoded seeker MiniStat block (lines 1053-1077)** with two config-driven groups:

```tsx
{
  /* Profile-level tiles */
}
<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
  {resolveTiles(seekerCfg?.dashboardTiles?.profile, DEFAULT_PROFILE_TILES, rollup).map((tile) => (
    <MiniStat key={`p-${tile.label}`} label={tile.label} value={fmtCount(tile.value)} />
  ))}
</div>;
{
  /* User-level tiles */
}
<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
  {resolveTiles(seekerCfg?.dashboardTiles?.user, DEFAULT_USER_TILES, rollup).map((tile) => (
    <MiniStat key={`u-${tile.label}`} label={tile.label} value={fmtCount(tile.value)} />
  ))}
</div>;
```

(`seekerTileLabels` at line 915 is now unused — remove that line. The `StatCard` status block at 1016-1051 stays unchanged.)

- [ ] **Step 3: Do the same for the provider tab.** Replace its MiniStat block (~1375-1393) using `providerCfg?.dashboardTiles?.profile` / `.user` with the same defaults.

- [ ] **Step 4: Typecheck.**

Run: `pnpm --filter @aggregator-dpg/web typecheck`
Expected: PASS for the tile changes (bucket/`by_action_status` errors remain until F2).

- [ ] **Step 5: Commit.**

```bash
git add "apps/web/src/app/(protected)/dashboard/page.tsx"
git commit -m "feat(web): config-driven profile + user tile groups"
```

### Task F2: Split the action column into Initiated + Received

**Files:**

- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx` — bucketLabels wiring (`:919`), table header (`:625`), funnel cell (`:667-697`), `ParticipantTable` props

- [ ] **Step 1: Replace the single `bucketLabels` (line 919)** with both directional maps:

```typescript
const initiatedLabels = cfg?.dashboardBuckets?.by_initiated_action_status ?? {};
const receivedLabels = cfg?.dashboardBuckets?.by_received_action_status ?? {};
```

`bucketLabels` is defined **twice** — seeker tab `:919` and provider tab `:1250`; replace both. Thread both maps into `ParticipantTable`: replace the `bucketLabels={bucketLabels}` prop at the seeker call `:1094` **and** the provider call `:1411` with `initiatedLabels={initiatedLabels} receivedLabels={receivedLabels}`. Update the `ParticipantTableProps` interface (`:393`, prop declared `:422`, defaulted `:435`) — replace `bucketLabels` with the two new props.

- [ ] **Step 2: Replace the single action `<th>` (line 625)** with two headers:

```tsx
<th>{t('table.initiated')}</th>
<th>{t('table.received')}</th>
```

- [ ] **Step 3: Replace the single `<td>` funnel cell (lines 667-697)** with two cells driven by `r.initiated` / `r.received`:

```tsx
<td>
  <FunnelCell
    total={r.initiated.create + r.initiated.accept + r.initiated.reject + r.initiated.cancel}
    parts={buildActionParts(r.initiated, initiatedLabels, getBucketFallback)}
  />
</td>
<td>
  <FunnelCell
    total={r.received.create + r.received.accept + r.received.reject + r.received.cancel}
    parts={buildActionParts(r.received, receivedLabels, getBucketFallback)}
  />
</td>
```

- [ ] **Step 4: Add the `buildActionParts` helper** near the other table helpers (reuses the existing `getBucketLabel` + funnel colour vars seen at lines 671-694):

```typescript
import type { DirectionalStats } from '../../../types';

function buildActionParts(
  stats: DirectionalStats,
  labels: Record<string, string | undefined>,
  fallback: (k: string) => string,
) {
  return [
    {
      v: stats.create,
      color: 'var(--bd-funnel-requested)',
      label: getBucketLabel(labels, 'create', fallback),
      short: getBucketLabel(labels, 'create', fallback),
    },
    {
      v: stats.accept,
      color: 'var(--bd-funnel-connected)',
      label: getBucketLabel(labels, 'accept', fallback),
      short: getBucketLabel(labels, 'accept', fallback),
    },
    {
      v: stats.reject,
      color: 'var(--bd-funnel-declined)',
      label: getBucketLabel(labels, 'reject', fallback),
      short: getBucketLabel(labels, 'reject', fallback),
    },
    {
      v: stats.cancel,
      color: 'var(--bd-funnel-cancelled)',
      label: getBucketLabel(labels, 'cancel', fallback),
      short: getBucketLabel(labels, 'cancel', fallback),
    },
  ];
}
```

- [ ] **Step 5: Add the two i18n keys** `table.initiated` / `table.received`. Run `grep -rn "table.applied" apps/web/src` to find the locale file(s); add `"initiated": "Initiated"` and `"received": "Received"` next to the existing `applied` key in each locale file.

- [ ] **Step 6: Widen the table `minWidth`** (line 602) — bump both branches by ~120px to fit the extra column (e.g. provider `1300`, seeker `1200`).

- [ ] **Step 7: Typecheck + lint + full web test.**

Run: `pnpm --filter @aggregator-dpg/web typecheck && pnpm --filter @aggregator-dpg/web lint && pnpm --filter @aggregator-dpg/web test`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add "apps/web/src/app/(protected)/dashboard/page.tsx" apps/web/src/locales 2>/dev/null || git add "apps/web/src/app/(protected)/dashboard/page.tsx"
git commit -m "feat(web): split action column into Initiated + Received"
```

---

## Part G — Full verification

### Task G1: Repo-wide gates

- [ ] **Step 1: Build, test, lint, typecheck, dep-check across the repo.**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm dep-check`
Expected: all PASS.

- [ ] **Step 2: Manual smoke (optional, needs local stack).** Bring up the stack, log in, open `/dashboard`. Verify: two tile rows (profile + user) render; the table shows separate Initiated and Received columns; labels reflect `network.json` when present, English fallback when absent. If signalstack (Part 0) is not yet shipped, the rollup user-level fields read 0 and directional maps render zeros — confirm no crash (defensive `?? 0`).

- [ ] **Step 3: Commit any test-snapshot updates, then open the PR.**

```bash
git push -u origin feat/user-level-metrics-directional-actions
gh pr create --base develop --title "feat(dashboard): user-level metrics + directional action columns" --body "Implements docs/superpowers/specs/2026-06-07-user-level-metrics-directional-actions-design.md. Aggregator-side (§2); signalstack §1 tracked separately. 🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes

- **Spec coverage:** §1 → Part 0 checklist (separate repo). §2.1 → A1/D1. §2.2 → B1/E1. §2.3 → C1/C2. §2.4 → F1. §2.5 → F2/D2. §2.6 → Part 0 (network.json is remote, owned by signalstack). Edge cases (missing `profile_item_id`/`user_id`, absent tiles, zero directional) → defensive defaults in D2/F1/F2 + G1 step 2.
- **Type consistency:** `DashboardTiles`/`DashboardTileDef` used identically in network-config (B1), api (C1), web hook (E1); `DirectionalStats` defined in D2, consumed in F2; `mapDirectional` defined once (D2) and used in `toSeekerRow`.
- **No aggregator computation:** tiles read rollup values by `field` key; no grouping anywhere. Matches the locked decision.
- **Open follow-up (out of scope):** provider-specific status logic (Satisfied/openings) and profile→user drill-in UI remain future work per the spec.
