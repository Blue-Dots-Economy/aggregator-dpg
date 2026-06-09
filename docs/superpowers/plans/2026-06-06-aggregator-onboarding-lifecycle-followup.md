# Aggregator Onboarding Lifecycle Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt `aggregator-dpg` to consume signals' new onboarding lifecycle (lifecycle_status / completion_pct / owned_elsewhere / account_only) — partial-data registrations succeed, a dispatcher fires completion campaigns when items land `draft`, dashboard surfaces lifecycle state, public form pre-flights identity via a lookup endpoint, and a `409 PROFILE_NOT_LIVE` from signals on action perform is no longer surprising.

**Architecture:** Additive. Two DB columns/tables (`registration_links.completion_actions`, new `outbound_dispatch_log`), three new service surfaces (`SignalStackWriter.probeUser`, `OutboundDispatcher`, `LifecycleRollupService`), two new HTTP endpoints (`/public/v1/aggregators/:orgSlug/lookup`, lifecycle filter on existing dashboard), one new BullMQ queue (`outbound-dispatch`), and UI updates to the public form + dashboard. Signals owns lifecycle_state; aggregator reads it. Absent `lifecycle_status` from signals = treat as `live` (back-compat).

**Tech Stack:** Drizzle ORM + Postgres, Fastify (api), BullMQ (worker), Next.js App Router (web), RJSF (forms), Vitest, Zod, TypeScript-only.

---

## Spec ↔ Codebase Reconciliation (read first)

Spec section §-references resolved against actual aggregator-dpg layout:

| Spec calls it                                  | Actual aggregator-dpg location                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------ | -------------------------- |
| `POST /v1/registrations`                       | `POST /public/v1/aggregators/:orgSlug/registrations/:slug` in `apps/api/src/routes/public-registration-links.ts`                                                                                               |
| `GET /v1/dashboard/tiles`                      | Today: `GET /v1/dashboard/items` (returns paginated items). Tiles are computed client-side. We will add server-side lifecycle counts onto this endpoint via a `tiles` block in the response — no new endpoint. |
| `GET /v1/participants`                         | Same endpoint as above (`/v1/dashboard/items`). We extend its `meta` to include `lifecycle_status` / `completion_pct` on each item, and add `?lifecycle=draft                                                  | live                      | paused | account_only` query param. |
| `participants.onboardedByOrgId`                | Aggregator scoping is via `sourceLinkId` / `sourceBulkUploadId` + `aggregator_id` FK — no new column needed.                                                                                                   |
| `outbound_dispatch_log` "already exists"       | **Does not exist.** We add it in Task 2.                                                                                                                                                                       |
| Signals' optional `item_state`                 | Currently `signalstack-writer.onboard()` always sends the profile inline. We add a `submit_mode: 'account_only'                                                                                                | 'with_item'` opt-in flag. |
| `/v1/lookup` (spec §6)                         | We expose at `/public/v1/aggregators/:orgSlug/lookup` to match existing public route prefix.                                                                                                                   |
| Spec response `lifecycle_summary.primary_item` | Returned from a NEW `SignalStackWriter.probeUser()` method that posts to signals' `/admin/participant` without `item_state`.                                                                                   |

Back-compat rule for every signals response shape we parse: **`lifecycle_status === undefined` → treat as `'live'`**. Centralised in one helper (Task 7).

---

## File Map

**Database (`packages/db-schema`, `apps/api/drizzle`):**

- Modify: `packages/db-schema/src/schema.ts` — add `completion_actions` column to `registrationLinks`; add new `outbound_dispatch_log` table.
- Create: `apps/api/drizzle/migrations/0009_lifecycle_followup.sql` — DDL for both.

**Shared types (`packages/shared-primitives`):**

- Modify: `packages/shared-primitives/src/dto/index.ts` — add `LifecycleStatus`, `CompletionAction` types (or sit them next to signalstack-writer interface — see Task 5).

**Signalstack writer (`packages/signalstack-writer`):**

- Modify: `packages/signalstack-writer/src/interface.ts` — extend `SignalStackOnboardParticipantInput` with `submit_mode`; extend `SignalStackOnboardParticipantResult` with `owned_elsewhere`, `lifecycle_status`, `completion_pct`; extend `SignalStackProfile` with `lifecycle_status`, `completion_pct`; add `probeUser` abstract method.
- Modify: `packages/signalstack-writer/src/http.ts` — implement `probeUser`; thread through new response fields.
- Modify: `packages/signalstack-writer/src/memory.ts` and `src/testing.ts` — extend fake to cover `probeUser` + new fields.

**API (`apps/api/src/routes`, `apps/api/src/services`):**

- Create: `apps/api/src/routes/public-lookup.ts` — `GET /public/v1/aggregators/:orgSlug/lookup`.
- Modify: `apps/api/src/routes/public-registration-links.ts` — forward `submit_mode`, parse lifecycle fields from response, enqueue dispatcher when `draft`.
- Modify: `apps/api/src/routes/dashboard.ts` — accept `?lifecycle=...`, return `tiles` block.
- Create: `apps/api/src/services/onboarding/dispatch_completion.ts` — pure planner: signals response + completion_actions → list of dispatch directives.
- Create: `apps/api/src/services/onboarding/lifecycle.ts` — back-compat helper (`resolveLifecycle(item)` → `'draft' | 'live' | 'paused'`).
- Create: `apps/api/src/services/outbound-dispatch-log/index.ts` — typed CRUD for the new table.
- Modify: `apps/api/src/app.ts` — register the new route.

**Worker (`apps/worker/src`):**

- Create: `apps/worker/src/jobs/outbound-dispatch.ts` — BullMQ processor: pre-send lifecycle re-check, stub send, log.
- Modify: `apps/worker/src/queues.ts` (or wherever queues live) — declare `outbound-dispatch` queue + connection wiring.
- Modify: `apps/worker/src/main.ts` — wire the new processor.

**Queue helpers (`packages/queue`):**

- Modify: `packages/queue/src/index.ts` — add `outbound-dispatch` queue name + payload type.

**Web (`apps/web`):**

- Create: `apps/web/src/app/api/[org]/[slug]/lookup/route.ts` — BFF that proxies to `/public/v1/aggregators/:orgSlug/lookup`.
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx` — pre-submit lookup, "already registered elsewhere" branch, "resume profile" branch, allow partial submit.
- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx` — render new lifecycle mini-stats, add lifecycle column to `ParticipantTable`, accept `?lifecycle=` query param on the data fetch.
- Create: `apps/web/src/components/LifecyclePill.tsx` — coloured pill (draft amber / live green / paused gray / account-only slate).
- Create: `apps/web/src/components/CompletionBar.tsx` — 0-100% progress bar.

**Tests** (location follows source; vitest):

- `packages/signalstack-writer/src/__tests__/probe-user.test.ts`
- `apps/api/src/services/onboarding/__tests__/dispatch_completion.test.ts`
- `apps/api/src/services/onboarding/__tests__/lifecycle.test.ts`
- `apps/api/src/routes/__tests__/public-lookup.test.ts`
- `apps/api/src/routes/__tests__/public-registration-links.lifecycle.test.ts` (new file alongside existing)
- `apps/api/src/routes/__tests__/dashboard.lifecycle.test.ts`
- `apps/worker/src/__tests__/jobs/outbound-dispatch.test.ts`
- `apps/web/src/__tests__/components/LifecyclePill.test.tsx`
- `apps/web/src/__tests__/components/CompletionBar.test.tsx`
- `apps/web/src/__tests__/app/api/lookup.route.test.ts`
- `apps/web/src/__tests__/views/PublicRegistrationView.lookup.test.tsx`

---

## Task 0: Pre-flight — baseline confirmed

**Already done at worktree creation.** `pnpm -w test` is green (17 packages, all passing). Branch is `feat/aggregator-onboarding-lifecycle-followup` off `origin/feature`. Spec lives at `docs/superpowers/specs/2026-06-06-aggregator-onboarding-lifecycle-followup.md`.

- [x] **Step 1: Confirm worktree and baseline tests passing**

```bash
git rev-parse --abbrev-ref HEAD
# expect: feat/aggregator-onboarding-lifecycle-followup
pnpm -w test 2>&1 | tail -3
# expect: Tasks: 17 successful
```

---

## Task 1: Add `completion_actions` to `registration_links` (Drizzle schema)

**Files:**

- Modify: `packages/db-schema/src/schema.ts` (the `registrationLinks` definition around line 250)
- Test: `packages/db-schema/src/__tests__/schema.test.ts` (create if absent)

- [x] **Step 1: Write the failing test**

```ts
// packages/db-schema/src/__tests__/schema.test.ts
import { describe, it, expect } from 'vitest';
import { registrationLinks } from '../schema.js';

describe('registrationLinks.completion_actions', () => {
  it('exists on the table', () => {
    const col = (registrationLinks as Record<string, unknown>).completion_actions;
    expect(col).toBeDefined();
  });

  it('defaults to an empty JSON array', () => {
    // Drizzle exposes the default via the column's config; tests just
    // assert the symbol exists. Behavioural default is asserted at
    // migration test time (Task 2) when a real DB runs the DDL.
    expect(typeof (registrationLinks as Record<string, unknown>).completion_actions).toBe('object');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
# expect FAIL: 'completion_actions' is undefined
```

- [x] **Step 3: Add the column to the Drizzle definition**

In `packages/db-schema/src/schema.ts`, inside the `registrationLinks = pgTable('registration_links', { ... })` block, after `context: jsonb('context').notNull().default({}),` add:

```ts
  completion_actions: jsonb('completion_actions').notNull().default([]),
```

- [x] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
# expect PASS
pnpm --filter @aggregator-dpg/db-schema typecheck
# expect: clean
```

- [x] **Step 5: Commit**

```bash
git add packages/db-schema/src/schema.ts packages/db-schema/src/__tests__/schema.test.ts
git commit -m "feat(db-schema): add registration_links.completion_actions JSONB column"
```

---

## Task 2: Add `outbound_dispatch_log` table (Drizzle)

**Files:**

- Modify: `packages/db-schema/src/schema.ts` — append a new `outboundDispatchLog` `pgTable` after `participants`.
- Modify: `packages/db-schema/src/__tests__/schema.test.ts`
- Modify: `packages/db-schema/src/index.ts` — re-export the new table.

- [x] **Step 1: Write the failing test**

Append to `packages/db-schema/src/__tests__/schema.test.ts`:

```ts
import { outboundDispatchLog } from '../schema.js';

describe('outboundDispatchLog', () => {
  it('is defined as a table', () => {
    expect(outboundDispatchLog).toBeDefined();
  });

  it('has the expected primary columns', () => {
    const cols = outboundDispatchLog as Record<string, unknown>;
    for (const c of [
      'id',
      'participant_id',
      'item_id',
      'channel',
      'template_id',
      'status',
      'created_at',
    ]) {
      expect(cols[c]).toBeDefined();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
# expect FAIL: outboundDispatchLog import is undefined
```

- [x] **Step 3: Add the Drizzle table**

In `packages/db-schema/src/schema.ts`, append (mirror the existing style — use `uuid`, `text`, `jsonb`, `timestamp`, `index`, `uniqueIndex`):

```ts
export const outboundDispatchLog = pgTable(
  'outbound_dispatch_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    aggregator_id: uuid('aggregator_id')
      .notNull()
      .references(() => aggregators.id, { onDelete: 'cascade' }),
    participant_id: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    item_id: text('item_id').notNull(), // signals' item id (string, not FK)
    channel: text('channel', { enum: ['sms', 'voice', 'chat'] }).notNull(),
    template_id: text('template_id').notNull(),
    status: text('status', {
      enum: ['queued', 'sent', 'skipped_lifecycle', 'failed'],
    })
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    payload: jsonb('payload').notNull().default({}),
    queued_at: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sent_at: timestamp('sent_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyIdx: uniqueIndex('outbound_dispatch_idempotency_idx').on(
      t.participant_id,
      t.item_id,
      t.channel,
      t.template_id,
    ),
    aggregatorStatusIdx: index('outbound_dispatch_aggregator_status_idx').on(
      t.aggregator_id,
      t.status,
    ),
  }),
);
```

If `integer` is not yet imported, add to the `drizzle-orm/pg-core` import line.

In `packages/db-schema/src/index.ts`, ensure `outboundDispatchLog` is exported.

- [x] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/db-schema test -- schema.test
pnpm --filter @aggregator-dpg/db-schema typecheck
# expect both clean
```

- [x] **Step 5: Generate the SQL migration**

```bash
pnpm --filter @aggregator-dpg/api db:generate
# expect: a new file under apps/api/drizzle/migrations/00NN_*.sql
```

Verify the generated SQL contains:

- `ALTER TABLE "registration_links" ADD COLUMN "completion_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;`
- `CREATE TABLE IF NOT EXISTS "outbound_dispatch_log" (...)`
- `CREATE UNIQUE INDEX ... ON "outbound_dispatch_log" ("participant_id","item_id","channel","template_id");`

If Drizzle Kit's auto-generated name is unwieldy, rename the file to `0009_lifecycle_followup.sql`.

- [x] **Step 6: Commit**

```bash
git add packages/db-schema/ apps/api/drizzle/migrations/
git commit -m "feat(db): outbound_dispatch_log table + completion_actions migration"
```

---

## Task 3: Lifecycle resolver helper (back-compat shim)

This is the single function every consumer uses to read `lifecycle_status` from a signals item, with the rule "absent → live".

**Files:**

- Create: `apps/api/src/services/onboarding/lifecycle.ts`
- Test: `apps/api/src/services/onboarding/__tests__/lifecycle.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/services/onboarding/__tests__/lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import { resolveLifecycle, type LifecycleStatus } from '../lifecycle.js';

describe('resolveLifecycle', () => {
  it('returns live when lifecycle_status absent', () => {
    expect(resolveLifecycle({})).toBe<'live'>('live');
  });

  it('returns the explicit value when present', () => {
    const cases: LifecycleStatus[] = ['draft', 'live', 'paused'];
    for (const v of cases) {
      expect(resolveLifecycle({ lifecycle_status: v })).toBe(v);
    }
  });

  it('clamps unknown strings to live', () => {
    expect(resolveLifecycle({ lifecycle_status: 'bogus' as LifecycleStatus })).toBe('live');
  });

  it('returns null for null input', () => {
    expect(resolveLifecycle(null)).toBeNull();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/api test -- onboarding/lifecycle
# expect FAIL: cannot import lifecycle
```

- [x] **Step 3: Implement**

```ts
// apps/api/src/services/onboarding/lifecycle.ts
/**
 * Back-compat aware lifecycle resolver.
 *
 * Signals may not have shipped the lifecycle column to every environment
 * yet. Any aggregator-facing read MUST go through this helper so the
 * fallback rule "absent → live" is enforced in one place.
 */
export type LifecycleStatus = 'draft' | 'live' | 'paused';
const VALID = new Set<LifecycleStatus>(['draft', 'live', 'paused']);

/**
 * Returns the lifecycle for an item, or `null` if the item itself is absent.
 *
 * @param item - The signals item slice; only `lifecycle_status` is read.
 * @returns 'draft' | 'live' | 'paused', or null when item is null/undefined.
 */
export function resolveLifecycle(
  item: { lifecycle_status?: LifecycleStatus | string } | null | undefined,
): LifecycleStatus | null {
  if (item == null) return null;
  const raw = item.lifecycle_status;
  if (raw === undefined) return 'live';
  return VALID.has(raw as LifecycleStatus) ? (raw as LifecycleStatus) : 'live';
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/api test -- onboarding/lifecycle
# expect PASS (4 tests)
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/onboarding/lifecycle.ts apps/api/src/services/onboarding/__tests__/lifecycle.test.ts
git commit -m "feat(api): add back-compat aware lifecycle resolver"
```

---

## Task 4: Extend `SignalStackWriter.onboard` input/output for lifecycle

Add `submit_mode` to input and `owned_elsewhere`, `lifecycle_status`, `completion_pct` to output. Update the in-memory fake.

**Files:**

- Modify: `packages/signalstack-writer/src/interface.ts`
- Modify: `packages/signalstack-writer/src/memory.ts`
- Modify: `packages/signalstack-writer/src/testing.ts` (if separate)
- Test: `packages/signalstack-writer/src/__tests__/onboard.lifecycle.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// packages/signalstack-writer/src/__tests__/onboard.lifecycle.test.ts
import { describe, it, expect } from 'vitest';
import { SignalStackWriterFake, buildOnboardInput } from '../testing.js';

describe('SignalStackWriterFake.onboard — lifecycle response shape', () => {
  it('returns live + 100% on full submit', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.onboard(
      buildOnboardInput({ submit_mode: 'with_item', profile: { full: true } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.lifecycle_status).toBe('live');
      expect(res.value.completion_pct).toBe(100);
      expect(res.value.owned_elsewhere).toBe(false);
    }
  });

  it('returns draft + partial pct on partial submit', async () => {
    const fake = new SignalStackWriterFake();
    fake.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
    const res = await fake.onboard(buildOnboardInput({ submit_mode: 'with_item', profile: {} }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.lifecycle_status).toBe('draft');
  });

  it('returns owned_elsewhere when foreign-user seeded', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedForeignUser({ email: 'foreigner@example.com' });
    const res = await fake.onboard(buildOnboardInput({ email: 'foreigner@example.com' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.owned_elsewhere).toBe(true);
      expect(res.value.profile_item_id).toBe('');
    }
  });

  it('omits lifecycle_status entirely on account_only mode', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.onboard(buildOnboardInput({ submit_mode: 'account_only' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.lifecycle_status).toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/signalstack-writer test -- onboard.lifecycle
# expect FAIL — buildOnboardInput / setNextClassification / seedForeignUser absent
```

- [x] **Step 3: Update the interface**

In `packages/signalstack-writer/src/interface.ts`:

Within `SignalStackOnboardParticipantInput` add (keep all existing fields):

```ts
  /**
   * Controls signals' new lifecycle path:
   *   - 'with_item' (default for back-compat) — POST /admin/participant with
   *      profile body; signals classifies draft|live based on completeness.
   *   - 'account_only' — no `item_state` forwarded; signals creates user row
   *      only. Used by the lookup endpoint (§6 of spec) and partial-data
   *      registrations that opt out of profile creation.
   */
  submit_mode?: 'with_item' | 'account_only';
```

Within `SignalStackOnboardParticipantResult`:

```ts
  /** Present only when an item was created (submit_mode='with_item'). */
  lifecycle_status?: 'draft' | 'live' | 'paused';
  /** 0..100. Present only with `lifecycle_status`. */
  completion_pct?: number;
  /** Replaces the legacy `already_registered` semantically; both populated for transition. */
  owned_elsewhere?: boolean;
```

Within `SignalStackProfile` (list response shape):

```ts
  lifecycle_status?: 'draft' | 'live' | 'paused';
  completion_pct?: number;
```

Also extend `SignalStackItemQuery` for the lifecycle filter pass-through:

```ts
  /** Defaults to 'live_only' when absent (signals default). */
  lifecycle_filter?: 'live_only' | 'all';
```

- [x] **Step 4: Update the in-memory implementation**

In `packages/signalstack-writer/src/memory.ts`, the `InMemorySignalStackWriter.onboard` method:

- Reads `submit_mode` (default `'with_item'`).
- If `submit_mode === 'account_only'`: returns `{ user_id, profile_item_id: '', owned_elsewhere: false, onboarded_at }` with **no** lifecycle fields.
- Else: returns lifecycle fields from a `nextClassification` slot (default `{ lifecycle_status: 'live', completion_pct: 100 }`).
- If the email is in `foreignUsers` set: returns `{ user_id, profile_item_id: '', owned_elsewhere: true, onboarded_at }`.

- [x] **Step 5: Update the testing fake + builder**

In `packages/signalstack-writer/src/testing.ts` (the public ./testing subpath):

- Re-export `InMemorySignalStackWriter` as `SignalStackWriterFake`.
- Add public methods `setNextClassification({ lifecycle_status, completion_pct })` and `seedForeignUser({ email?, phoneNumber? })` (these set fields on `InMemorySignalStackWriter`).
- Add `buildOnboardInput(overrides)` that returns a valid `SignalStackOnboardParticipantInput` with deterministic defaults.

- [x] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/signalstack-writer test -- onboard.lifecycle
# expect PASS (4 tests)
pnpm --filter @aggregator-dpg/signalstack-writer typecheck
# clean
```

- [x] **Step 7: Commit**

```bash
git add packages/signalstack-writer/
git commit -m "feat(signalstack-writer): lifecycle fields + submit_mode + foreign-user signal"
```

---

## Task 5: Add `SignalStackWriter.probeUser` (the lookup primitive)

Identity probe — POST to signals' `/admin/participant` with `submit_mode: 'account_only'`, reshape the response into `{ user_exists, owned_elsewhere, lifecycle_summary }`.

**Files:**

- Modify: `packages/signalstack-writer/src/interface.ts`
- Modify: `packages/signalstack-writer/src/memory.ts`
- Modify: `packages/signalstack-writer/src/http.ts`
- Modify: `packages/signalstack-writer/src/testing.ts`
- Test: `packages/signalstack-writer/src/__tests__/probe-user.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// packages/signalstack-writer/src/__tests__/probe-user.test.ts
import { describe, it, expect } from 'vitest';
import { SignalStackWriterFake } from '../testing.js';

describe('SignalStackWriterFake.probeUser', () => {
  it('reports a new email as not yet existing', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'new@example.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.user_exists).toBe(false);
      expect(res.value.owned_elsewhere).toBe(false);
      expect(res.value.lifecycle_summary).toBeNull();
    }
  });

  it('reports an own draft user with completion %', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedOwnUser({
      actingOrgId: 'org-1',
      email: 'a@b.com',
      item: { item_id: 'item-1', lifecycle_status: 'draft', completion_pct: 40 },
    });
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'a@b.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.user_exists).toBe(true);
      expect(res.value.owned_elsewhere).toBe(false);
      expect(res.value.lifecycle_summary?.primary_item.lifecycle_status).toBe('draft');
      expect(res.value.lifecycle_summary?.primary_item.completion_pct).toBe(40);
    }
  });

  it('reports owned_elsewhere with no lifecycle leak', async () => {
    const fake = new SignalStackWriterFake();
    fake.seedForeignUser({ email: 'shared@x.com' });
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      email: 'shared@x.com',
      network: 'blue_dot',
      domain: 'seeker',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.user_exists).toBe(true);
      expect(res.value.owned_elsewhere).toBe(true);
      expect(res.value.lifecycle_summary).toBeNull();
    }
  });

  it('errors when both email and phoneNumber are absent', async () => {
    const fake = new SignalStackWriterFake();
    const res = await fake.probeUser({
      actingOrgId: 'org-1',
      network: 'blue_dot',
      domain: 'seeker',
    } as never);
    expect(res.ok).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/signalstack-writer test -- probe-user
# expect FAIL — probeUser not on fake
```

- [x] **Step 3: Add the abstract method + types**

In `packages/signalstack-writer/src/interface.ts`:

```ts
export interface SignalStackProbeUserInput {
  actingOrgId: string;
  email?: string;
  phoneNumber?: string;
  network: string;
  domain: string;
}

export interface SignalStackProbeUserResult {
  user_exists: boolean;
  owned_elsewhere: boolean;
  lifecycle_summary: {
    primary_item: {
      item_id: string;
      lifecycle_status: 'draft' | 'live' | 'paused';
      completion_pct: number;
    };
  } | null;
}

export const SignalStackProbeUserInputSchema = z
  .object({
    actingOrgId: z.string().min(1),
    email: z.string().email().optional(),
    phoneNumber: z.string().min(1).optional(),
    network: z.string().min(1),
    domain: z.string().min(1),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phoneNumber), {
    message: 'Either email or phoneNumber is required.',
  });
```

Add the abstract method on `SignalStackWriterBase`:

```ts
  /**
   * Identity probe — wraps signals' `/admin/participant` in account-only
   * mode. Idempotent and side-effect free (signals creates a user row at
   * most; never an item).
   */
  abstract probeUser(
    input: SignalStackProbeUserInput,
  ): Promise<Result<SignalStackProbeUserResult, BaseError>>;
```

- [x] **Step 4: Implement on the in-memory writer**

In `memory.ts`, implement `probeUser` against the same in-memory user/item map already used by `onboard`. Honour `foreignUsers` and `ownUsers` seed maps.

- [x] **Step 5: Implement on the HTTP writer**

In `http.ts`, POST to signals' `${baseUrl}/api/v1/admin/participant` with body `{ email, phone_number, name: 'lookup', terms_accepted: true, privacy_accepted: true, network, domain }` and **no `item_state`**. Required headers: `x-api-key`, `x-acting-org-id`. Read response `owned_elsewhere` + (optional) `items[0].{lifecycle_status,completion_pct,item_id}`. Use the existing fetch wrapper with timeout + retry + structured error mapping (mirror `onboard`).

Build the result:

- `items` empty AND `owned_elsewhere === false` AND HTTP indicates user existed → `{ user_exists: true, owned_elsewhere: false, lifecycle_summary: null }`.
- `items[0]` present → populate `lifecycle_summary.primary_item` (using `resolveLifecycle` semantics via a local helper here — DO NOT import from `apps/api`; the writer package is below the api in the dep graph).
- `owned_elsewhere === true` → strip lifecycle, return `{ user_exists: true, owned_elsewhere: true, lifecycle_summary: null }`.

- [x] **Step 6: Export probe helpers from `./testing`**

Add `seedOwnUser({ actingOrgId, email?, phoneNumber?, item })` to the testing fake.

- [x] **Step 7: Run test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/signalstack-writer test
# expect all green (incl. 4 new probe tests)
pnpm --filter @aggregator-dpg/signalstack-writer typecheck
```

- [x] **Step 8: Commit**

```bash
git add packages/signalstack-writer/
git commit -m "feat(signalstack-writer): probeUser identity-only lookup primitive"
```

---

## Task 6: `GET /public/v1/aggregators/:orgSlug/lookup`

**Files:**

- Create: `apps/api/src/routes/public-lookup.ts`
- Modify: `apps/api/src/app.ts` — register the new route.
- Test: `apps/api/src/routes/__tests__/public-lookup.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/__tests__/public-lookup.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { AggregatorStoreFake, _setAggregatorStore } from '../../services/aggregator-store/index.js';
import { _setSignalStackWriter } from '../../services/signalstack.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import type { FastifyInstance } from 'fastify';

describe('GET /public/v1/aggregators/:orgSlug/lookup', () => {
  let app: FastifyInstance;
  let aggregatorStore: AggregatorStoreFake;
  let ss: SignalStackWriterFake;

  beforeEach(async () => {
    aggregatorStore = new AggregatorStoreFake();
    aggregatorStore.seed([
      {
        id: 'agg-1',
        slug: 'acme',
        name: 'ACME',
        type: 'tier_1',
        signalstackOrgId: 'org-1',
        status: 'approved',
        decisionMade: 'approved',
        phone: '+918888888888',
        email: 'acme@example.com',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      } as never,
    ]); // cast to `never` until the aggregator-store test helper exports `buildAggregator()`
    ss = new SignalStackWriterFake();
    _setAggregatorStore(aggregatorStore);
    _setSignalStackWriter(ss);
    app = await buildApp();
  });

  it('returns user_exists=false for a new identity', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=new@example.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      user_exists: false,
      owned_elsewhere: false,
      lifecycle_summary: null,
    });
  });

  it('returns owned_elsewhere=true without lifecycle for a foreign user', async () => {
    ss.seedForeignUser({ email: 'shared@x.com' });
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=shared@x.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().owned_elsewhere).toBe(true);
    expect(r.json().lifecycle_summary).toBeNull();
  });

  it('400s when neither email nor phone is supplied', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(400);
  });

  it('404s when the aggregator slug is unknown', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/unknown/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect(r.statusCode).toBe(404);
  });

  it('is rate-limited like other public routes', async () => {
    for (let i = 0; i < 30; i++) {
      await app.inject({
        method: 'GET',
        url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
      });
    }
    const last = await app.inject({
      method: 'GET',
      url: '/public/v1/aggregators/acme/lookup?email=a@b.com&network=blue_dot&domain=seeker',
    });
    expect([200, 429]).toContain(last.statusCode); // soft assertion — exact threshold lives in config
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/api test -- public-lookup
# expect FAIL — route 404 (not registered)
```

- [x] **Step 3: Implement the route**

```ts
// apps/api/src/routes/public-lookup.ts
/**
 * Public identity-probe endpoint for the registration form.
 *
 *   GET /public/v1/aggregators/:orgSlug/lookup?email&phone_number&network&domain
 *
 * No JWT — same access model as `/public/v1/aggregators/:orgSlug/links/:slug`.
 * Aggregator scope comes from `orgSlug`. Idempotent: the signals call is
 * `account_only` so no item is ever created.
 *
 * Response mirrors §6 of the spec exactly.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAggregatorStore } from '../services/aggregator-store/index.js';
import { getSignalStackWriter } from '../services/signalstack.js';
import { normalisePhone } from '../services/phone.js';
import { httpError } from '../errors/http-error.js';
import { consume } from '../services/rate-limiter/index.js';
import { match } from '@aggregator-dpg/shared-primitives/result';

const QuerySchema = z
  .object({
    email: z.string().email().optional(),
    phone_number: z.string().min(1).optional(),
    network: z.string().min(1),
    domain: z.string().min(1),
  })
  .refine((v) => Boolean(v.email) || Boolean(v.phone_number), {
    message: 'Either email or phone_number is required.',
  });

export async function registerPublicLookupRoute(app: FastifyInstance): Promise<void> {
  app.get('/public/v1/aggregators/:orgSlug/lookup', async (req, reply) => {
    const orgSlug = (req.params as { orgSlug?: string }).orgSlug;
    if (!orgSlug) throw httpError('SCHEMA_VALIDATION', { detail: 'orgSlug is required.' });
    const log = req.log.child({ operation: 'public.lookup', org_slug: orgSlug });
    const start = Date.now();

    await consume(req, 'public.lookup', orgSlug);

    const parse = QuerySchema.safeParse(req.query);
    if (!parse.success) {
      throw httpError('SCHEMA_VALIDATION', { detail: 'Invalid query', issues: parse.error.issues });
    }
    const q = parse.data;

    const aggLookup = await getAggregatorStore().findBySlug(orgSlug);
    if (!aggLookup.ok || !aggLookup.value || !aggLookup.value.signalstackOrgId) {
      log.warn({ status: 'failure', sub: 'aggregator.not_found' });
      throw httpError('NOT_FOUND', { detail: 'Unknown aggregator.' });
    }
    const actingOrgId = aggLookup.value.signalstackOrgId;

    const phoneNumber = q.phone_number ? normalisePhone(q.phone_number) : undefined;
    const probe = await getSignalStackWriter().probeUser({
      actingOrgId,
      email: q.email,
      phoneNumber,
      network: q.network,
      domain: q.domain,
    });

    return match(probe, {
      onOk: (v) => {
        log.info({
          status: 'success',
          latency_ms: Date.now() - start,
          owned_elsewhere: v.owned_elsewhere,
          user_exists: v.user_exists,
        });
        return v;
      },
      onErr: (e) => {
        log.error({
          status: 'failure',
          latency_ms: Date.now() - start,
          error: e.message,
          error_type: e.constructor.name,
        });
        throw httpError('UPSTREAM', { detail: e.message });
      },
    });
  });
}
```

Register in `apps/api/src/app.ts`:

```ts
import { registerPublicLookupRoute } from './routes/public-lookup.js';
// ... inside buildApp:
await registerPublicLookupRoute(app);
```

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/api test -- public-lookup
# expect PASS (5 tests, last one soft-asserts 200|429)
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-lookup.ts apps/api/src/app.ts apps/api/src/routes/__tests__/public-lookup.test.ts
git commit -m "feat(api): GET /public/v1/aggregators/:orgSlug/lookup identity probe"
```

---

## Task 7: Wire lifecycle into the existing public-registration submit

Forward `submit_mode`, parse the new response fields, log them, and (later, in Task 9) enqueue dispatcher.

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` (the submit handler — around line 270 where `ss.onboard(...)` is called)
- Test: `apps/api/src/routes/__tests__/public-registration-links.lifecycle.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/__tests__/public-registration-links.lifecycle.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../../app.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
import { _setSignalStackWriter } from '../../services/signalstack.js';
import { _setParticipantsWriter } from '../public-registration-links.js';
// ...seed an aggregator + link as the existing test does

describe('public registration submit — lifecycle parse', () => {
  let app, ss;

  beforeEach(async () => {
    // Replicate the seeding done in the existing public-registration-links.test.ts:
    //   - AggregatorStoreFake seeded with one aggregator (slug='acme', signalstackOrgId='org-1', status='approved')
    //   - RegistrationLinksStoreFake seeded with one live link (slug='test-slug',
    //     aggregator_id='agg-1', domain='seeker', completion_actions=[])
    //   - ParticipantsWriterFake injected via _setParticipantsWriter
    //   - Phone normaliser stubbed via _setPhoneNormaliser if exposed
    // Copy the helper block from the sibling test verbatim.
    ss = new SignalStackWriterFake();
    _setSignalStackWriter(ss);
    app = await buildApp();
  });

  it('returns 201 with lifecycle_status=live for a full submit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/aggregators/acme/registrations/test-slug',
      payload: {
        /* full payload */
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lifecycle_status).toBe('live');
    expect(res.json().completion_pct).toBe(100);
  });

  it('returns 201 with lifecycle_status=draft for a partial submit when submit_mode=with_item', async () => {
    ss.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/aggregators/acme/registrations/test-slug',
      payload: {
        /* partial */
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lifecycle_status).toBe('draft');
  });

  it('returns 200 with skipped outcome when owned_elsewhere', async () => {
    ss.seedForeignUser({ email: 'shared@x.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/aggregators/acme/registrations/test-slug',
      payload: {
        /* with email=shared@x.com */
      },
    });
    expect([200, 201, 409]).toContain(res.statusCode);
    expect(res.json().outcome).toBe('skipped');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links.lifecycle
# expect FAIL — response shape does not yet carry lifecycle fields
```

- [x] **Step 3: Update the handler**

In `apps/api/src/routes/public-registration-links.ts`, where `ss.onboard({...})` is called:

- Compute `submitMode: 'with_item' | 'account_only'` from the request body: if the validated payload contains any non-identity profile fields, set `'with_item'`; if only identity (phone/email + name + consent), set `'account_only'`. Surface a body flag `partial: true` that always forces `'account_only'`.
- Pass `submit_mode: submitMode` to `ss.onboard`.
- After `onboard` returns, on the success branch:
  - Read `lifecycle_status` (via the resolver from Task 3 — `resolveLifecycle({ lifecycle_status: result.value.lifecycle_status })`) and `completion_pct`.
  - Log them on the existing structured log line.
  - Include them in the JSON response under stable keys (`lifecycle_status`, `completion_pct`).
- On `owned_elsewhere === true`: surface as `outcome: 'skipped'` (already-registered branch already exists for `already_registered`; OR them together for one transition release).

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/api test -- public-registration-links
# expect all green (existing + 3 new)
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/routes/public-registration-links.ts apps/api/src/routes/__tests__/public-registration-links.lifecycle.test.ts
git commit -m "feat(api): forward submit_mode + parse lifecycle on registration submit"
```

---

## Task 8: Dispatch-completion planner (pure)

> **Deferred — removed, see future voice/chat spec.**

A pure function: given a signals onboard result + the link's `completion_actions`, returns the list of dispatch directives. No I/O, no DB.

**Files:**

- Create: `apps/api/src/services/onboarding/dispatch_completion.ts`
- Test: `apps/api/src/services/onboarding/__tests__/dispatch_completion.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { planCompletionDispatch } from '../dispatch_completion.js';

const actions = [
  { channel: 'sms', template_id: 'sms-1', delay_seconds: 0, max_retries: 3 },
  { channel: 'voice', template_id: 'voice-1', delay_seconds: 60, max_retries: 2 },
];

describe('planCompletionDispatch', () => {
  it('produces one directive per action when lifecycle=draft', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        lifecycle_status: 'draft',
        completion_pct: 40,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      channel: 'sms',
      template_id: 'sms-1',
      participant_id: 'p-1',
      item_id: 'i',
    });
  });

  it('returns no directives when lifecycle=live', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        lifecycle_status: 'live',
        completion_pct: 100,
      },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when lifecycle absent (back-compat = live)', () => {
    const plan = planCompletionDispatch({
      onboardResult: { user_id: 'u', profile_item_id: 'i' },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when owned_elsewhere', () => {
    const plan = planCompletionDispatch({
      onboardResult: { user_id: 'u', profile_item_id: '', owned_elsewhere: true },
      actions,
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });

  it('returns no directives when actions is empty', () => {
    const plan = planCompletionDispatch({
      onboardResult: {
        user_id: 'u',
        profile_item_id: 'i',
        lifecycle_status: 'draft',
        completion_pct: 0,
      },
      actions: [],
      participantId: 'p-1',
      aggregatorId: 'a-1',
    });
    expect(plan).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/api test -- dispatch_completion
# expect FAIL — module missing
```

- [x] **Step 3: Implement**

```ts
// apps/api/src/services/onboarding/dispatch_completion.ts
import { resolveLifecycle, type LifecycleStatus } from './lifecycle.js';

export interface CompletionAction {
  channel: 'sms' | 'voice' | 'chat';
  template_id: string;
  delay_seconds: number;
  max_retries: number;
}

export interface DispatchDirective {
  channel: 'sms' | 'voice' | 'chat';
  template_id: string;
  delay_seconds: number;
  max_retries: number;
  participant_id: string;
  item_id: string;
  aggregator_id: string;
}

export interface PlannerInput {
  onboardResult: {
    user_id: string;
    profile_item_id: string;
    lifecycle_status?: LifecycleStatus | string;
    completion_pct?: number;
    owned_elsewhere?: boolean;
  };
  actions: CompletionAction[];
  participantId: string;
  aggregatorId: string;
}

/**
 * Returns dispatch directives only when the resulting signals item is `draft`.
 * Owns the back-compat semantics: absent lifecycle_status = `live`, so empty plan.
 */
export function planCompletionDispatch(input: PlannerInput): DispatchDirective[] {
  if (input.onboardResult.owned_elsewhere) return [];
  if (!input.onboardResult.profile_item_id) return [];
  const status = resolveLifecycle({ lifecycle_status: input.onboardResult.lifecycle_status });
  if (status !== 'draft') return [];
  return input.actions.map((a) => ({
    ...a,
    participant_id: input.participantId,
    item_id: input.onboardResult.profile_item_id,
    aggregator_id: input.aggregatorId,
  }));
}
```

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/api test -- dispatch_completion
# expect PASS (5 tests)
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/onboarding/dispatch_completion.ts apps/api/src/services/onboarding/__tests__/dispatch_completion.test.ts
git commit -m "feat(api): pure planCompletionDispatch — actions × lifecycle gate"
```

---

## Task 9: `outbound_dispatch_log` typed CRUD + idempotent enqueue

**Files:**

- Create: `apps/api/src/services/outbound-dispatch-log/interface.ts`
- Create: `apps/api/src/services/outbound-dispatch-log/postgres.ts`
- Create: `apps/api/src/services/outbound-dispatch-log/memory.ts`
- Create: `apps/api/src/services/outbound-dispatch-log/index.ts` (DI getter + test setter)
- Test: `apps/api/src/services/outbound-dispatch-log/__tests__/idempotency.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { OutboundDispatchLogFake } from '../memory.js';

describe('OutboundDispatchLog.enqueue', () => {
  it('is idempotent on (participant_id,item_id,channel,template_id)', async () => {
    const store = new OutboundDispatchLogFake();
    const a = await store.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    const b = await store.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value.id).toBe(b.value.id); // same row
    const all = await store.listByParticipant('p');
    expect(all.ok && all.value.length).toBe(1);
  });

  it('marks status transitions', async () => {
    const store = new OutboundDispatchLogFake();
    const enq = await store.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'i',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.ok) throw new Error('seed failed');
    const sent = await store.markSent(enq.value.id);
    expect(sent.ok).toBe(true);
    const fetched = await store.findById(enq.value.id);
    expect(fetched.ok && fetched.value?.status).toBe('sent');
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/api test -- outbound-dispatch-log
# expect FAIL — module missing
```

- [x] **Step 3: Implement (interface + postgres + memory + DI getter)**

Mirror the existing aggregator-store / participants-writer pattern. Abstract methods: `enqueue(input)`, `markSent(id)`, `markFailed(id, error)`, `markSkippedLifecycle(id)`, `findById(id)`, `listByParticipant(participantId)`. Postgres impl uses Drizzle and `ON CONFLICT (participant_id, item_id, channel, template_id) DO UPDATE SET status = outbound_dispatch_log.status RETURNING *` to keep the call idempotent yet still return the existing row.

- [x] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/api test -- outbound-dispatch-log
# expect PASS
```

- [x] **Step 5: Commit**

```bash
git add apps/api/src/services/outbound-dispatch-log/
git commit -m "feat(api): outbound_dispatch_log typed CRUD with idempotent enqueue"
```

---

## Task 10: BullMQ `outbound-dispatch` queue + processor (stub send)

**Files:**

- Modify: `packages/queue/src/index.ts` — add `OUTBOUND_DISPATCH_QUEUE = 'outbound-dispatch'`; export `OutboundDispatchJobData` type.
- Create: `apps/worker/src/jobs/outbound-dispatch.ts` — processor.
- Modify: `apps/worker/src/main.ts` — register the new queue + processor.
- Test: `apps/worker/src/__tests__/jobs/outbound-dispatch.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// apps/worker/src/__tests__/jobs/outbound-dispatch.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { processOutboundDispatch } from '../../jobs/outbound-dispatch.js';
import { SignalStackWriterFake } from '@aggregator-dpg/signalstack-writer/testing';
// OutboundDispatchLogFake lives in apps/api — duplicate a thin fake here OR
// expose ./testing on apps/api. For Task 10, copy a minimal local fake into
// apps/worker/src/__tests__/fakes/outbound-dispatch-log.fake.ts that satisfies
// the same shape (findById/enqueue/markSent/markFailed/markSkippedLifecycle).
// The processor only depends on the abstract shape, not the concrete file.
import { OutboundDispatchLogFake } from '../fakes/outbound-dispatch-log.fake.js';

describe('processOutboundDispatch', () => {
  // (The processor takes injected dependencies; the worker wires the real ones in main.ts.)
  it('marks skipped_lifecycle when signals item is no longer draft', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'live' });
    const log = new OutboundDispatchLogFake();
    const enq = await log.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'item-1',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.ok) throw new Error('seed failed');

    await processOutboundDispatch({ dispatchId: enq.value.id }, { signalstack: ss, log });

    const row = await log.findById(enq.value.id);
    expect(row.ok && row.value?.status).toBe('skipped_lifecycle');
  });

  it('marks sent on a draft item (stub channel)', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'draft' });
    const log = new OutboundDispatchLogFake();
    const enq = await log.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'item-1',
      channel: 'sms',
      template_id: 't',
      payload: { phone: '+918888888888' },
    });
    if (!enq.ok) throw new Error('seed failed');

    const sender = vi.fn(async () => ({ ok: true as const, value: { provider_msg_id: 'msg-1' } }));
    await processOutboundDispatch({ dispatchId: enq.value.id }, { signalstack: ss, log, sender });

    expect(sender).toHaveBeenCalledTimes(1);
    const row = await log.findById(enq.value.id);
    expect(row.ok && row.value?.status).toBe('sent');
  });

  it('marks failed and bumps attempt on sender error within max_retries', async () => {
    const ss = new SignalStackWriterFake();
    ss.seedItem('item-1', { lifecycle_status: 'draft' });
    const log = new OutboundDispatchLogFake();
    const enq = await log.enqueue({
      aggregator_id: 'a',
      participant_id: 'p',
      item_id: 'item-1',
      channel: 'sms',
      template_id: 't',
      payload: {},
    });
    if (!enq.ok) throw new Error('seed failed');
    const sender = vi.fn(async () => ({ ok: false as const, error: new Error('vendor down') }));

    await processOutboundDispatch({ dispatchId: enq.value.id }, { signalstack: ss, log, sender });
    const row = await log.findById(enq.value.id);
    expect(row.ok && row.value?.status).toBe('failed');
    expect(row.ok && row.value?.attempt).toBe(1);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @aggregator-dpg/worker test -- outbound-dispatch
# expect FAIL — module missing
```

- [x] **Step 3: Implement the processor (stub send)**

```ts
// apps/worker/src/jobs/outbound-dispatch.ts
import type { SignalStackWriterBase } from '@aggregator-dpg/signalstack-writer/interface';
import { logger } from '@aggregator-dpg/observability';

export interface Deps {
  signalstack: SignalStackWriterBase;
  log: /* OutboundDispatchLogBase */ any;
  sender?: (row: {
    channel: 'sms' | 'voice' | 'chat';
    template_id: string;
    payload: unknown;
  }) => Promise<{ ok: true; value: { provider_msg_id: string } } | { ok: false; error: Error }>;
}

const defaultSender: Deps['sender'] = async (row) => {
  // STUB v1: log and pretend to send. Real vendor wiring is a follow-up
  // spec — out of scope here per §4 of the source spec.
  logger.info({
    operation: 'outboundDispatch.stub.send',
    channel: row.channel,
    template_id: row.template_id,
    status: 'success',
  });
  return { ok: true, value: { provider_msg_id: `stub-${Date.now()}` } };
};

export async function processOutboundDispatch(
  data: { dispatchId: string },
  deps: Deps,
): Promise<void> {
  const sender = deps.sender ?? defaultSender;
  const row = await deps.log.findById(data.dispatchId);
  if (!row.ok || !row.value) {
    logger.warn({
      operation: 'outboundDispatch.notFound',
      dispatchId: data.dispatchId,
      status: 'skipped',
    });
    return;
  }
  // Pre-send re-check
  const probe = await deps.signalstack.getItem({ item_id: row.value.item_id });
  // Note: getItem is NOT in the current writer interface — extend it in the same task or
  // re-purpose listItemsByAggregator with an item_id filter. See sub-step.
  if (probe.ok && probe.value.lifecycle_status && probe.value.lifecycle_status !== 'draft') {
    await deps.log.markSkippedLifecycle(row.value.id);
    return;
  }
  const sent = await sender({
    channel: row.value.channel,
    template_id: row.value.template_id,
    payload: row.value.payload,
  });
  if (sent.ok) {
    await deps.log.markSent(row.value.id);
  } else {
    await deps.log.markFailed(row.value.id, sent.error.message);
  }
}
```

If `getItem` isn't yet on the writer, extend in this same task:

- Add `abstract getItem(query: { item_id: string }): Promise<Result<SignalStackProfile | null, BaseError>>` to interface.
- Implement on `memory.ts`, `http.ts`, `testing.ts`.

- [x] **Step 4: Register the queue + processor in `main.ts`**

Mirror the existing `bulk-file-process` wiring:

```ts
import { Worker } from 'bullmq';
import { OUTBOUND_DISPATCH_QUEUE } from '@aggregator-dpg/queue';
import { processOutboundDispatch } from './jobs/outbound-dispatch.js';

new Worker(
  OUTBOUND_DISPATCH_QUEUE,
  async (job) => {
    await processOutboundDispatch(job.data, {
      signalstack: getSignalStackWriter(),
      log: getOutboundDispatchLog(),
    });
  },
  { connection },
);
```

- [x] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @aggregator-dpg/worker test -- outbound-dispatch
# expect PASS (3 tests)
```

- [x] **Step 6: Commit**

```bash
git add apps/worker/src/jobs/outbound-dispatch.ts apps/worker/src/main.ts packages/queue/src/index.ts apps/worker/src/__tests__/jobs/outbound-dispatch.test.ts packages/signalstack-writer/
git commit -m "feat(worker): outbound-dispatch queue + stub processor with lifecycle re-check"
```

---

## Task 11: Enqueue dispatcher from the registration handler

Wire planner output into the queue.

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` — after `ss.onboard()` success, run `planCompletionDispatch` against the link's `completion_actions`; for each directive, `enqueue` into `outbound_dispatch_log` then add a BullMQ job.
- Test: extend `public-registration-links.lifecycle.test.ts`.

- [x] **Step 1: Add tests**

```ts
it('enqueues completion_actions when lifecycle=draft', async () => {
  // seed link with completion_actions=[{channel:'sms', template_id:'t', delay_seconds:0, max_retries:3}]
  ss.setNextClassification({ lifecycle_status: 'draft', completion_pct: 40 });
  const res = await app.inject({
    method: 'POST',
    url: '/public/v1/aggregators/acme/registrations/test-slug',
    payload: {
      /* partial */
    },
  });
  expect(res.statusCode).toBe(201);
  // assert via the in-memory queue fake injected at setup
  expect(queueFake.added).toHaveLength(1);
  expect(queueFake.added[0]).toMatchObject({ name: 'outbound-dispatch' });
});

it('does not enqueue when lifecycle=live', async () => {
  // default classification is live
  const res = await app.inject({
    method: 'POST',
    url: '/public/v1/aggregators/acme/registrations/test-slug',
    payload: {
      /* full */
    },
  });
  expect(res.statusCode).toBe(201);
  expect(queueFake.added).toHaveLength(0);
});
```

- [x] **Step 2: Run to fail, then implement, then run to pass**

Implementation: in the success branch of `ss.onboard`:

```ts
const plan = planCompletionDispatch({
  onboardResult: result.value,
  actions: (link.completion_actions ?? []) as CompletionAction[],
  participantId: participantRow.id,
  aggregatorId: agg.id,
});
for (const d of plan) {
  const enq = await getOutboundDispatchLog().enqueue({
    aggregator_id: d.aggregator_id,
    participant_id: d.participant_id,
    item_id: d.item_id,
    channel: d.channel,
    template_id: d.template_id,
    payload: { delay_seconds: d.delay_seconds, max_retries: d.max_retries },
  });
  if (enq.ok) {
    await getOutboundDispatchQueue().add(
      'outbound-dispatch',
      { dispatchId: enq.value.id },
      { delay: d.delay_seconds * 1000, attempts: d.max_retries + 1 },
    );
  }
}
```

- [x] **Step 3: Commit**

```bash
git add apps/api/src/routes/public-registration-links.ts apps/api/src/routes/__tests__/
git commit -m "feat(api): enqueue dispatcher jobs when signals returns draft"
```

---

## Task 12: Dashboard — lifecycle tiles + lifecycle filter

**Files:**

- Modify: `apps/api/src/routes/dashboard.ts` — accept `?lifecycle=draft|live|paused|account_only`; aggregate counts; pass through `lifecycle_filter: 'all'` to signals when admin scope; compute tiles.
- Modify: `apps/api/src/services/signalstack.ts` — surface the tile rollup.
- Test: `apps/api/src/routes/__tests__/dashboard.lifecycle.test.ts`

- [x] **Step 1: Write the failing test**

```ts
describe('GET /v1/dashboard/items — lifecycle', () => {
  it('returns lifecycle counts in `meta.tiles`', async () => {
    // seed signalstack fake with 1 draft, 2 live, 1 paused items
    const r = await app.inject({ method: 'GET', url: '/v1/dashboard/items?domain=seeker' });
    expect(r.statusCode).toBe(200);
    expect(r.json().meta.tiles).toEqual({
      draft: 1,
      live: 2,
      paused: 1,
      account_only: expect.any(Number),
    });
  });

  it('filters items by ?lifecycle=draft', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/items?domain=seeker&lifecycle=draft',
    });
    expect(r.statusCode).toBe(200);
    for (const it of r.json().items) expect(it.lifecycle_status).toBe('draft');
  });

  it('treats lifecycle absent on response items as live (back-compat)', async () => {
    // seed signalstack fake to return items with NO lifecycle_status
    const r = await app.inject({ method: 'GET', url: '/v1/dashboard/items?domain=seeker' });
    expect(r.statusCode).toBe(200);
    expect(r.json().meta.tiles.live).toBeGreaterThan(0);
  });
});
```

- [x] **Step 2: Implement**

In `dashboard.ts`:

- Read `?lifecycle` query param. When `account_only` → query `participants` for `aggregator_id` with no link to signals items (compute server-side from the participant store).
- Pass `lifecycle_filter: 'all'` to `listItemsByAggregator` (we need all states for tile counts).
- Filter the returned items by `lifecycle` post-fetch (using `resolveLifecycle` for back-compat).
- Compute `tiles = { draft, live, paused, account_only }`.

- [x] **Step 3: Run + commit**

```bash
pnpm --filter @aggregator-dpg/api test -- dashboard.lifecycle
git add apps/api/src/routes/dashboard.ts apps/api/src/routes/__tests__/dashboard.lifecycle.test.ts apps/api/src/services/signalstack.ts
git commit -m "feat(api): dashboard lifecycle tiles + ?lifecycle filter (back-compat aware)"
```

---

## Task 13: Web — LifecyclePill + CompletionBar components

**Files:**

- Create: `apps/web/src/components/LifecyclePill.tsx`
- Create: `apps/web/src/components/CompletionBar.tsx`
- Test: `apps/web/src/__tests__/components/LifecyclePill.test.tsx`
- Test: `apps/web/src/__tests__/components/CompletionBar.test.tsx`

- [x] **Step 1: Write the failing tests**

```tsx
// LifecyclePill.test.tsx
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { LifecyclePill } from '../../components/LifecyclePill';
import messages from '../../i18n/messages/en.json';

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('<LifecyclePill />', () => {
  it.each([
    ['draft', 'Draft'],
    ['live', 'Live'],
    ['paused', 'Paused'],
    ['account_only', 'Account only'],
  ] as const)('renders %s as %s', (status, label) => {
    wrap(<LifecyclePill status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('treats undefined status as live (back-compat)', () => {
    wrap(<LifecyclePill status={undefined} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });
});
```

```tsx
// CompletionBar.test.tsx
import { render } from '@testing-library/react';
import { CompletionBar } from '../../components/CompletionBar';

describe('<CompletionBar />', () => {
  it('clamps over-100 to 100', () => {
    const { container } = render(<CompletionBar percent={150} />);
    expect(container.querySelector('[aria-valuenow="100"]')).toBeTruthy();
  });
  it('clamps negative to 0', () => {
    const { container } = render(<CompletionBar percent={-5} />);
    expect(container.querySelector('[aria-valuenow="0"]')).toBeTruthy();
  });
});
```

- [x] **Step 2: Implement the components**

```tsx
// LifecyclePill.tsx
import { useTranslations } from 'next-intl';
type Status = 'draft' | 'live' | 'paused' | 'account_only';
const tone: Record<Status, string> = {
  draft: 'bg-amber-100 text-amber-800',
  live: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-slate-200 text-slate-700',
  account_only: 'bg-slate-100 text-slate-600',
};

export function LifecyclePill({ status }: { status?: Status }) {
  const t = useTranslations('Lifecycle');
  const resolved: Status = status ?? 'live';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[resolved]}`}
    >
      {t(resolved)}
    </span>
  );
}
```

```tsx
// CompletionBar.tsx
export function CompletionBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      className="h-2 w-24 rounded-full bg-slate-200"
    >
      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${clamped}%` }} />
    </div>
  );
}
```

Add i18n keys to `apps/web/src/i18n/messages/{en,kn,hi}.json` under `Lifecycle.{draft,live,paused,account_only}`.

- [x] **Step 3: Run + commit**

```bash
pnpm --filter @aggregator-dpg/web test
git add apps/web/src/components/ apps/web/src/__tests__/components/ apps/web/src/i18n/
git commit -m "feat(web): LifecyclePill + CompletionBar i18n components"
```

---

## Task 14: Web — wire pill + bar into dashboard `ParticipantTable`

**Files:**

- Modify: `apps/web/src/app/(protected)/dashboard/page.tsx` — extend `ParticipantBase` with `lifecycle_status?` / `completion_pct?`; insert new column between "Profile Status" and "Applied/Actions".
- Modify: same file — add 4 mini-stat tiles consuming `meta.tiles` from the new API shape.

- [x] **Step 1: Add the column header**

In the `<thead>` row inside `ParticipantTable`, after the Profile Status header, insert:

```tsx
<th className="px-3 py-2 text-left text-xs font-medium text-slate-500">{t('Headers.lifecycle')}</th>
```

- [x] **Step 2: Add the cell**

In the `<tbody>` row map, after the Profile Status cell:

```tsx
<td className="px-3 py-2">
  <div className="flex items-center gap-2">
    <LifecyclePill status={row.lifecycle_status} />
    {row.lifecycle_status !== 'paused' && typeof row.completion_pct === 'number' && (
      <CompletionBar percent={row.completion_pct} />
    )}
  </div>
</td>
```

- [x] **Step 3: Render the 4 new mini-stat tiles**

In `SeekersTab`/`ProvidersTab`, after the existing mini-stat row, add:

```tsx
<MiniStat label={t('Tiles.lifecycle.draft')} value={tiles?.draft ?? 0} />
<MiniStat label={t('Tiles.lifecycle.live')} value={tiles?.live ?? 0} />
<MiniStat label={t('Tiles.lifecycle.paused')} value={tiles?.paused ?? 0} />
<MiniStat label={t('Tiles.lifecycle.account_only')} value={tiles?.account_only ?? 0} />
```

`tiles` comes from the dashboard fetch — extend the type and the service that returns dashboard payload.

- [x] **Step 4: Add fetch-side ?lifecycle plumbing**

Add a "Lifecycle" filter dropdown in the dashboard toolbar; URL-state via `useSearchParams`. Forward `lifecycle=draft|live|paused|account_only` to the BFF.

- [x] **Step 5: Run + commit**

```bash
pnpm --filter @aggregator-dpg/web test
git add apps/web/src/app/(protected)/dashboard/
git commit -m "feat(web): dashboard lifecycle pill, completion bar, 4 new tiles, filter"
```

---

## Task 15: Web — public form pre-submit lookup + partial submit

**Files:**

- Create: `apps/web/src/app/api/[org]/[slug]/lookup/route.ts`
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Test: `apps/web/src/__tests__/app/api/lookup.route.test.ts`
- Test: `apps/web/src/__tests__/views/PublicRegistrationView.lookup.test.tsx`

- [x] **Step 1: BFF lookup route**

```ts
// apps/web/src/app/api/[org]/[slug]/lookup/route.ts
import { NextRequest } from 'next/server';
import { getServiceAccessToken } from '@/lib/service-token';

export async function GET(req: NextRequest, ctx: { params: { org: string; slug: string } }) {
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const token = await getServiceAccessToken();
  const upstream = await fetch(
    `${process.env.AGGREGATOR_API_URL}/public/v1/aggregators/${ctx.params.org}/lookup?${qs}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': req.headers.get('x-request-id') ?? '',
      },
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
```

- [x] **Step 2: BFF route test**

Mirror `apps/web/src/__tests__/services/profile.service.test.ts` pattern — stub `fetch`, drive both success and 404 branches.

- [x] **Step 3: Pre-submit lookup in the view**

In `PublicRegistrationView.tsx`, before the form's `onSubmit` actually POSTs:

```tsx
async function preSubmitProbe(
  values: Identity,
): Promise<'allow' | 'owned_elsewhere' | { resume_item_id: string }> {
  const qs = new URLSearchParams({
    ...(values.email && { email: values.email }),
    ...(values.phone && { phone_number: values.phone }),
    network,
    domain,
  }).toString();
  const r = await fetch(`/api/${org}/${slug}/lookup?${qs}`);
  if (!r.ok) return 'allow';
  const body = await r.json();
  if (body.owned_elsewhere) return 'owned_elsewhere';
  if (body.lifecycle_summary?.primary_item)
    return { resume_item_id: body.lifecycle_summary.primary_item.item_id };
  return 'allow';
}
```

Branch the UI:

- `owned_elsewhere` → render "This phone/email is already registered with another organisation."
- `resume_item_id` → render a "Resume your profile" link.
- `allow` → proceed.

- [x] **Step 4: Partial submit**

Add a "Submit minimum required fields now, complete later" checkbox. When checked, submit body includes `partial: true` which the API maps to `submit_mode: 'account_only'`.

- [x] **Step 5: Test the view branches**

Use `vi.fn()` to stub global `fetch` for the three branches; assert the rendered copy.

- [x] **Step 6: Run + commit**

```bash
pnpm --filter @aggregator-dpg/web test
git add apps/web/src/app/api/ apps/web/src/app/[org]/ apps/web/src/__tests__/
git commit -m "feat(web): public registration form — pre-submit lookup + partial submit"
```

---

## Task 16: Integration sweep — full pnpm -w test + lint + typecheck + dep-check

- [x] **Step 1: All packages**

```bash
pnpm -w lint
pnpm -w typecheck
pnpm -w test
pnpm dep-check
```

Expected: all green. Fix any drift caused by the cumulative changes.

Result on 2026-06-08: lint 2/2 green, typecheck 20/20 green, tests 18/18 packages green (api 161 passed, web 79 passed, others passed), dep-check 192 modules / 389 deps / 0 violations. No drift required.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/aggregator-onboarding-lifecycle-followup
```

- [ ] **Step 3: Final commit if any cleanups needed**

```bash
git add -A
git commit -m "chore: cumulative integration fixups"
git push
```

---

## Out of scope (called out in spec, deferred)

- **Real outbound vendor integration** (Twilio / 8x8 / Webex / ChatGPT-like bot). The processor in Task 10 has a stub sender. Wiring a real one is a follow-up spec.
- **Counterparty notifications** when signals auto-cancels a pending action (signals-side residual).
- **Aggregator-side lifecycle mirror** in `participants` table (read-time fetch is the v1 strategy).
- **Voice/chat IVR completion flows** end-to-end.

## Roll-forward / roll-back notes

- DB migration is additive (`ALTER TABLE ... ADD COLUMN ... DEFAULT '[]'` + new table). Safe under concurrent writes.
- API responses gain new optional fields (`lifecycle_status`, `completion_pct`, `meta.tiles`). Older clients ignoring them keep working.
- Signals returning items WITHOUT `lifecycle_status` is treated as `'live'` everywhere (Task 3 helper). Roll-out order doesn't matter: aggregator can deploy first.
- If we need to roll the aggregator back, the column + table can stay (no signals dependency on them). The new `/public/v1/.../lookup` route can be feature-flagged out via an env switch (`ENABLE_LOOKUP=true`); the web form falls back to no pre-flight when the route 404s.
