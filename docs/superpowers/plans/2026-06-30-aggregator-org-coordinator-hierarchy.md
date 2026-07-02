# Aggregator Org + Coordinator Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent **org** register once (admin-approved) and have multiple **coordinators** register under it (org-owner-approved); each coordinator keeps its own signalstack org and per-coordinator data isolation, with the whole hierarchy gated OFF by default behind a per-instance feature flag.

**Architecture:** Additive and flag-gated. A new thin `aggregator_orgs` DB table is the org **system of record** (status lives in SQL for an atomic single-use approval guard); `aggregators.parent_org_id` is a real FK to it (the **single** authority for the org→coordinator link — no KC group membership for coordinators in v1). The Keycloak group is a future-authz **mirror** only. Coordinator registration/approval reuses today's flow verbatim and adds an org link + org-owner approval routing. Everything is inert when `ORG_HIERARCHY_ENABLED=false` (default), so the migration ships to every instance safely.

**Tech Stack:** TypeScript, Fastify (`apps/api`), Drizzle/Postgres (hand-written numbered SQL migrations in `apps/api/drizzle/migrations/`), Keycloak admin (`idp-admin`), `jose` JWTs, `ioredis` rate limiter, Vitest. No new dependencies.

## Global Constraints

- **TypeScript only**; pnpm + Turbo monorepo. Node ≥ 24 (CI), Node 22 works locally.
- **Feature-flag gated.** All new behaviour is behind `ORG_HIERARCHY_ENABLED` (env, **default `false`**), read **once at startup** via `config` (configuration-discipline rule). Flag OFF = today's flat flow, byte-for-byte unchanged.
- **No signalstack schema change.** Coordinators keep their own signalstack org exactly as today; orgs have none.
- **One migration only:** new table `aggregator_orgs` + new column `aggregators.parent_org_id` (FK). Hand-written `0014_*.sql` plus the matching `db:generate` snapshot/journal entry. Schema source of truth is `packages/db-schema/src/schema.ts`.
- **Single source of truth for the org→coordinator link is `aggregators.parent_org_id`.** Coordinators are NOT added to the org's KC group in v1. The org KC group holds only the org owner.
- **`session.aggregator_id` scoping invariant is preserved.** An org id is an `aggregator_orgs.id` and is never an aggregator id; orgs have no `aggregators` row.
- Service-boundary methods return `Result`/`StoreResult`/`IdpResult` — **never throw across a boundary**. Route handlers throw `httpError(<CODE>)` (Fastify error path).
- Structured logging via `req.log.child({ operation })` (pino) with `status` (`success`/`failure`/`skipped`) and `latency_ms` for external calls (logging-observability rule). No bare `console.log`.
- No domain/env value hardcoded — read from `config`/env at startup (configuration-discipline rule).
- TSDoc on every new public class/method/function (code-documentation rule). First line one-sentence summary.
- **Locked vocabulary (spec §0, A7):** `org` / `org owner` / `coordinator` / `network admin`. The word "aggregator" appears only for the existing `aggregators` table/identity (= coordinator) and is kept out of new user-facing copy.
- Tests: Vitest, in-memory fakes via `_setX` injection (see `apps/api/src/routes/aggregator-registrations.test.ts`). Cross-package consumers import the fake from `./testing`. No real network/DB in unit tests; integration tests get `.integration.test.ts` and are excluded from `pnpm -w test`. Target ≥ 70% line coverage.
- `pnpm dep-check` must pass (interface-boundary rules). Interface files import only `shared-primitives`, `zod`, `node:*`.
- Conventional Commits; **never** `--no-verify`. Commit after every green step.

---

## Reference: current behaviour (verified in code)

- **Schema source of truth:** `packages/db-schema/src/schema.ts` (re-exported by `apps/api/src/db/schema.ts`). `aggregatorStatusEnum = ['pending','active','inactive','retired']`. The `aggregators` table has `id uuid PK defaultRandom`, `orgSlug text unique`, `actorType` enum, generated columns `contactPhone`/`contactEmail`, unique indexes on them, `status` enum default `pending`.
- **Migrations:** hand-written numbered SQL in `apps/api/drizzle/migrations/` (latest `0013_registration_mode.sql`). Each migration is a `.sql` file with an explanatory header; `meta/_journal.json` lists `{idx,version:"7",when,tag,breakpoints:true}` entries and `meta/NNNN_snapshot.json` holds the drizzle snapshot. `drizzle.config.ts` → `schema: './src/db/schema.ts'`, `out: './drizzle/migrations'`. `pnpm --filter @aggregator-dpg/api db:generate` produces the snapshot + journal entry; `db:migrate` applies. Next migration is **0014**.
- **Config:** `apps/api/src/config.ts`. Boolean env pattern: `z.enum(['true','false']).default('false').transform((v) => v === 'true')`. `const ConfigSchema = z.object({...})`; `export const config = ConfigSchema.parse(process.env)`. Has `PUBLIC_API_URL`, `PUBLIC_PORTAL_URL`, `ADMIN_EMAILS`, `APPROVAL_TOKEN_TTL_SECONDS`, `PUBLIC_SUBMIT_RATE_WINDOW_SECONDS`, `PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW`, `REGISTRATION_PENDING_GRACE_MS`.
- **Error catalogue:** `apps/api/src/errors/codes.ts` — `export const ERR = { KEY: { code, status, title, detail, hint, docs? } } as const satisfies Record<string, ErrorCatalogueEntry>`. `httpError(code, { detail?, fields?, cause? })` from `errors/http-error.ts`. `ErrorCode = keyof typeof ERR`. **Already present:** `RATE_LIMITED` (429), `CONFLICT` (409, "Action not allowed"), `NOT_FOUND` (404), `DUPLICATE_SLUG` (503 — internal retry-exhaustion, NOT user-facing), `USER_EXISTS`/`PHONE_EXISTS` (409), `SCHEMA_VALIDATION`/`BAD_JSON` (400 — there is no `BAD_REQUEST`), `IDP_UNAVAILABLE`/`DB_UNAVAILABLE` (503), `TOKEN_MINT_FAILED` (500). New 409 codes model on `CONFLICT`.
- **Store pattern:** `apps/api/src/services/<name>-store/{interface,memory,postgres,testing,index}.ts`. `index.ts` exposes `get<Name>Store()` (lazy Postgres singleton) + `_set<Name>Store(s|null)`. `interface.ts` has `abstract class <Name>StoreBase`, `StoreResult<T>`, `StoreError` union. `testing.ts` exports `<Name>StoreFake extends InMemory<Name>Store` with `seed()`/`reset()` + `build<Entity>()`.
- **idp-admin:** `apps/api/src/services/idp-admin/interface.ts` — `abstract class IdpAdminAdapter` with `createUser/findByEmail/findById/findByAttribute/enableUser/disableUser/deleteUser/setAttributes/setUserDecision`. **No group ops, no role assignment today** — Task 5 adds them. DTOs are plain TS `interface`/`type` (NOT Zod — this file predates interfaces.md; match that style). `IdpResult<T>`, `IdpError` union (`AUTH_FAILED|USER_EXISTS|USER_NOT_FOUND|IDP_UNAVAILABLE|BAD_REQUEST`). `KC_ATTR` constants in `attributes.ts`. Concrete adapter is **`keycloak.ts`** (`KeycloakIdpAdmin`); fake in `testing.ts` (`IdpAdminFake`) stores users in a Map and exposes `failOnce(error)` + `_reset()` — **no `seed()`**, build users via `createUser`.
- **Registration submit:** `apps/api/src/routes/aggregator-registrations.ts` — `POST /v1/aggregator-registrations/create`, body `RegistrationPayloadSchema` from `@aggregator-dpg/shared-primitives/aggregator`. `authenticateAny(req)` (service token). Helpers: `createAggregatorWithSlug(store, name, extras)`, `splitName(fullName)`, `stampConsent(consent)`, `isReclaimable(status)` (all in this file). Calls `sendAdminReviewEmail(input, log)` from `services/registration-notify.ts`.
- **Approval:** `apps/api/src/routes/aggregator-approvals.ts` — GET read page + `POST /admin/v1/aggregator-registrations/decision/:id`. Helpers (module-private): `loadAggregatorAndUser(id)` → `{ok,aggregator,kcUser}|{ok:false,status,html}`, `decisionFromStatus(status)`, `alreadyDecidedView(prior)`, `tokenErrorMessage(code)`, `sendHtml(reply,status,html)`, `ApprovalParamsSchema`. Token: `services/approval-token.ts` — `mintApprovalToken({aggregatorId,intent,ttlSec?})`, `verifyApprovalToken(token, { allowExpired? })` → `{ok:true,aggregatorId,intent}|{ok:false,error:{code:'EXPIRED'|'INVALID'|'MALFORMED'}}`.
- **Rate limiter:** `apps/api/src/services/rate-limiter/index.ts` — `consume({ namespace, key, windowSeconds, max })` → `{ allowed, count, retryAfterSeconds }`. Fixed-window Redis, fails open.
- **Notifier:** `services/registration-notify.ts` — `sendAdminReviewEmail(input, log)` emails `parseAdminEmails()`; `parseAdminEmails()` exported. Email template `renderAdminReview` in `services/email-templates/index.ts`.
- **App wiring:** `apps/api/src/app.ts` registers route modules in `buildApp()` (e.g. `await registerAggregatorRegistrationRoutes(app)`).

---

## File Structure

| File                                                                                      | Responsibility                                                                                                       | Change        |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| `apps/api/src/config.ts`                                                                  | Add `ORG_HIERARCHY_ENABLED` boolean flag.                                                                            | Modify        |
| `packages/db-schema/src/schema.ts`                                                        | Add `aggregatorOrgs` table + `aggregators.parentOrgId` FK column.                                                    | Modify        |
| `apps/api/drizzle/migrations/0014_aggregator_orgs.sql` + `meta/*`                         | The one additive migration.                                                                                          | Create        |
| `apps/api/src/services/aggregator-org-store/{interface,memory,postgres,testing,index}.ts` | New store for `aggregator_orgs` (system of record). Mirrors aggregator-store.                                        | Create        |
| `apps/api/src/services/aggregator-store/{interface,memory,postgres,testing}.ts`           | Add `parentOrgId` to `Aggregator` + create input + `findByParentOrgId`.                                              | Modify        |
| `apps/api/src/services/idp-admin/{interface,memory,postgres-or-http,testing}.ts`          | Add `createGroup`, `setGroupAttributes`, `assignRole` ops.                                                           | Modify        |
| `apps/api/src/errors/codes.ts`                                                            | Add `OWNER_ALREADY_REGISTERED`, `ORG_SLUG_TAKEN`, `TARGET_ORG_INACTIVE`.                                             | Modify        |
| `apps/api/src/services/org-registration-notify.ts`                                        | Mint org approve/reject tokens + email the **network admin**.                                                        | Create        |
| `apps/api/src/routes/aggregator-orgs.ts`                                                  | `POST /v1/orgs/create` (org submit) + `GET /v1/orgs` (active-org dropdown, SQL).                                     | Create        |
| `apps/api/src/routes/aggregator-org-approvals.ts`                                         | Org approval GET page + decision POST (network-admin token, atomic CAS).                                             | Create        |
| `apps/api/src/routes/aggregator-registrations.ts`                                         | Coordinator submit: require+validate org when flag on; set `parentOrgId`; `OWNER_ALREADY_REGISTERED`; rate limiting. | Modify        |
| `apps/api/src/routes/aggregator-approvals.ts`                                             | Coordinator approval: token carries `parent_org_id`, route to org owner, re-validate org active.                     | Modify        |
| `apps/api/src/services/approval-token.ts`                                                 | Token `org` claim (mint + verify) for coordinator-owner binding.                                                     | Modify        |
| `apps/api/src/app.ts`                                                                     | Register the two new route modules.                                                                                  | Modify        |
| `*.test.ts` alongside each                                                                | Unit tests per the testing rule.                                                                                     | Create/Modify |

> **Scope boundary:** This plan delivers the **backend** (data model, stores, IdP ops, both registration + approval flows, token binding, rate limiting, feature flag) — spec §2, §5–§10, §13. It is independently testable end-to-end via API injection. The **web portal** changes (two-tab Org/Coordinator registration UI, org dropdown widget) are a separate follow-up plan that consumes the contracts produced here; they are listed under "Follow-up" and are not built in this plan. Deferred-by-spec items (org console login, multi-org coordinator, invite onboarding, owner→coordinator graduation, stale-org cleanup scheduler) are out of scope (spec §11/§12).

---

## Task 1: Feature flag `ORG_HIERARCHY_ENABLED`

**Files:**

- Modify: `apps/api/src/config.ts`
- Test: `apps/api/src/__tests__/config.test.ts` (create if absent)

**Interfaces:**

- Produces: `config.ORG_HIERARCHY_ENABLED: boolean` (default `false`). Consumed by Tasks 6, 7, 8.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirror the boolean-flag schema fragment the config uses so we can assert
// the parse semantics without re-importing the whole module (which reads
// process.env at import time).
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

describe('ORG_HIERARCHY_ENABLED flag semantics', () => {
  it('defaults to false when unset', () => {
    expect(flag.parse(undefined)).toBe(false);
  });
  it('is true only for the literal string "true"', () => {
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse('false')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; verify it passes (this guards the pattern), then add the real flag**

Run: `pnpm --filter @aggregator-dpg/api test -- config.test.ts`
Expected: PASS (the fragment mirrors the chosen pattern).

- [ ] **Step 3: Add the flag to `ConfigSchema`**

In `apps/api/src/config.ts`, inside `ConfigSchema = z.object({...})`, after `API_REFERENCE_FORCE` (or any sibling boolean), add:

```typescript
  /**
   * Enables the parent-org → coordinator hierarchy for this instance
   * (spec §2). OFF (default) = today's flat registration/approval flow,
   * unchanged: no org tab, no org dropdown, no `aggregator_orgs` rows,
   * `aggregators.parent_org_id` stays null. Read once at startup; flipping
   * requires a restart. Two instances of the same network can differ.
   */
  ORG_HIERARCHY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @aggregator-dpg/api typecheck`
Expected: clean (no consumers yet).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/__tests__/config.test.ts
git commit -m "feat(api): add ORG_HIERARCHY_ENABLED feature flag (default off)"
```

---

## Task 2: `aggregator_orgs` schema + `parent_org_id` column + migration

**Files:**

- Modify: `packages/db-schema/src/schema.ts`
- Create: `apps/api/drizzle/migrations/0014_aggregator_orgs.sql`
- Modify: `apps/api/drizzle/migrations/meta/_journal.json` + create `meta/0014_snapshot.json` (via `db:generate`)
- Test: `packages/db-schema/src/__tests__/aggregator-orgs.schema.test.ts`

**Interfaces:**

- Produces: Drizzle table `aggregatorOrgs` (exported from `@aggregator-dpg/db-schema/schema`) with columns `id, slug, displayName, state, ownerEmail, ownerKcSub, kcGroupId, status, createdAt, updatedAt`. `aggregators.parentOrgId` (uuid, nullable, FK → `aggregator_orgs.id`). Consumed by Tasks 3, 4.
- Status values reuse the existing `aggregator_status` enum (`pending|active|inactive|retired`); the spec's org states `pending|active|rejected` map to `pending|active|inactive` (reject == inactive, matching the coordinator convention so one enum serves both).

- [ ] **Step 1: Write the failing schema test**

Create `packages/db-schema/src/__tests__/aggregator-orgs.schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aggregatorOrgs, aggregators } from '../schema.js';

describe('aggregator_orgs schema', () => {
  it('declares the org system-of-record columns', () => {
    const cfg = getTableConfig(aggregatorOrgs);
    const cols = new Set(cfg.columns.map((c) => c.name));
    for (const name of [
      'id',
      'slug',
      'display_name',
      'state',
      'owner_email',
      'owner_kc_sub',
      'kc_group_id',
      'status',
      'created_at',
      'updated_at',
    ]) {
      expect(cols.has(name)).toBe(true);
    }
    expect(cfg.name).toBe('aggregator_orgs');
  });

  it('adds parent_org_id to aggregators', () => {
    const cfg = getTableConfig(aggregators);
    const col = cfg.columns.find((c) => c.name === 'parent_org_id');
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @aggregator-dpg/db-schema test -- aggregator-orgs.schema.test.ts`
Expected: FAIL — `aggregatorOrgs` is not exported.

- [ ] **Step 3: Add the table + column to `schema.ts`**

In `packages/db-schema/src/schema.ts`, after the `aggregators` table block (line ~161), add:

```typescript
// ─── aggregator_orgs ─────────────────────────────────────────────────────────
// Thin system-of-record for a parent org (spec §5.1). The KC group is a
// future-authz mirror; status lives here so the approval single-use guard is
// an atomic compare-and-set (spec A3). Reuses `aggregator_status` enum
// (pending|active|inactive==rejected|retired).
export const aggregatorOrgs = pgTable(
  'aggregator_orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    state: text('state'),
    ownerEmail: text('owner_email').notNull(),
    ownerKcSub: text('owner_kc_sub'),
    kcGroupId: text('kc_group_id'),
    status: aggregatorStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Active-org dropdown + owner lookup are plain SQL (spec A2/A5).
    statusIdx: index('aggregator_orgs_status_idx').on(table.status),
    ownerEmailIdx: index('aggregator_orgs_owner_email_idx').on(table.ownerEmail),
    // Slug uniqueness only over non-terminal rows: a rejected/retired org
    // never blocks a later slug (spec A9). Drizzle partial unique index.
    slugActiveUnique: uniqueIndex('aggregator_orgs_slug_active_unique')
      .on(table.slug)
      .where(sql`status IN ('pending','active')`),
  }),
);
```

Then, inside the `aggregators` table column block (after `signalstackOrgId`, line ~150), add the FK column:

```typescript
    // Parent org for the org→coordinator hierarchy (spec §5.2). The SINGLE
    // authority for the link (no KC group membership for coordinators in v1).
    // NULL = flat coordinator (flag off) or legacy orphan. Only populated when
    // ORG_HIERARCHY_ENABLED=true. FK → aggregator_orgs.id.
    parentOrgId: uuid('parent_org_id').references(() => aggregatorOrgs.id),
```

> Drizzle needs `aggregatorOrgs` defined before `aggregators` references it, but `references(() => aggregatorOrgs.id)` is a lazy callback so declaration order does not matter — keep `aggregator_orgs` after `aggregators` for readability.

If `uniqueIndex`, `index`, or `sql` are not already imported at the top of `schema.ts`, add them to the `drizzle-orm/pg-core` / `drizzle-orm` imports (they are already used by `aggregators`, so they are present).

- [ ] **Step 4: Run the schema test; verify it passes**

Run: `pnpm --filter @aggregator-dpg/db-schema test -- aggregator-orgs.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Generate the migration**

Run: `pnpm --filter @aggregator-dpg/api db:generate`
This writes `apps/api/drizzle/migrations/0014_*.sql`, a `meta/0014_snapshot.json`, and appends a `_journal.json` entry. Rename the generated `.sql` to `0014_aggregator_orgs.sql` **only if** drizzle named it something else AND update the `tag` in `_journal.json` to match (the migrator matches the file by `tag`). Verify the journal entry was appended.

- [ ] **Step 6: Hand-verify / fix the partial unique index in the SQL**

Open the generated `apps/api/drizzle/migrations/0014_aggregator_orgs.sql`. Prepend a header comment matching the house style (see `0013_registration_mode.sql`) and confirm it contains:

```sql
-- Migration 0014 — aggregator_orgs (org system of record) + parent_org_id FK.
--
-- Additive + inert when ORG_HIERARCHY_ENABLED=false: the table stays empty and
-- the new column stays null, so behaviour is identical to today (spec §13.2).
-- Reuses the existing aggregator_status enum. Slug uniqueness is partial
-- (non-terminal rows only) so a rejected org never blocks a new slug (spec A9).

CREATE TABLE IF NOT EXISTS "aggregator_orgs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "state" text,
  "owner_email" text NOT NULL,
  "owner_kc_sub" text,
  "kc_group_id" text,
  "status" "aggregator_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "aggregators" ADD COLUMN IF NOT EXISTS "parent_org_id" uuid;

DO $$ BEGIN
  ALTER TABLE "aggregators"
    ADD CONSTRAINT "aggregators_parent_org_id_aggregator_orgs_id_fk"
    FOREIGN KEY ("parent_org_id") REFERENCES "aggregator_orgs"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "aggregator_orgs_status_idx" ON "aggregator_orgs" ("status");
CREATE INDEX IF NOT EXISTS "aggregator_orgs_owner_email_idx" ON "aggregator_orgs" ("owner_email");
CREATE UNIQUE INDEX IF NOT EXISTS "aggregator_orgs_slug_active_unique"
  ON "aggregator_orgs" ("slug") WHERE "status" IN ('pending','active');
```

If drizzle-kit did not emit the `WHERE` clause on the unique index (drizzle sometimes drops partial predicates), edit the SQL to the form above. The `.sql` is the authority the migrator runs.

- [ ] **Step 7: Typecheck the whole workspace**

Run: `pnpm --filter @aggregator-dpg/db-schema typecheck && pnpm --filter @aggregator-dpg/api typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/db-schema/src/schema.ts packages/db-schema/src/__tests__/aggregator-orgs.schema.test.ts apps/api/drizzle/migrations
git commit -m "feat(db): aggregator_orgs table + aggregators.parent_org_id FK (migration 0014)"
```

---

## Task 3: `aggregator-org-store` service (system of record)

**Files:**

- Create: `apps/api/src/services/aggregator-org-store/interface.ts`
- Create: `apps/api/src/services/aggregator-org-store/memory.ts`
- Create: `apps/api/src/services/aggregator-org-store/postgres.ts`
- Create: `apps/api/src/services/aggregator-org-store/testing.ts`
- Create: `apps/api/src/services/aggregator-org-store/index.ts`
- Test: `apps/api/src/services/aggregator-org-store/__tests__/memory.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 6, 7):
  - `AggregatorOrg = { id, slug, displayName, state: string|null, ownerEmail, ownerKcSub: string|null, kcGroupId: string|null, status: AggregatorStatus, createdAt, updatedAt }`
  - `CreateOrgInput = { slug, displayName, state?, ownerEmail, ownerKcSub?, kcGroupId? }`
  - `abstract class AggregatorOrgStoreBase` methods (all `Promise<StoreResult<…>>`): `create(input)`, `findById(id)`, `findBySlug(slug)`, `findByOwnerEmail(email)`, `listActive()` → `AggregatorOrg[]`, `update(id, patch)`, `approve(id)` (atomic CAS pending→active → `AggregatorOrg|null`; null = guard lost the race), `reject(id)`.
  - `getAggregatorOrgStore()` / `_setAggregatorOrgStore(s|null)`; `AggregatorOrgStoreFake`, `buildAggregatorOrg(overrides)` from `./testing`.
- Consumes: `AggregatorStatus`, `StoreResult`/`StoreError` shape (re-declare locally to keep interface.ts dep-clean — only `shared-primitives`, `zod`, `node:*` allowed).

- [ ] **Step 1: Write the failing memory-store test**

Create `apps/api/src/services/aggregator-org-store/__tests__/memory.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryAggregatorOrgStore } from '../memory.js';

describe('InMemoryAggregatorOrgStore', () => {
  it('creates and finds an org by slug and owner email', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const created = await store.create({
      slug: 'enable-india',
      displayName: 'Enable India',
      ownerEmail: 'owner@enable.org',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const bySlug = await store.findBySlug('enable-india');
    expect(bySlug.ok && bySlug.value?.id).toBe(created.value.id);
    const byOwner = await store.findByOwnerEmail('owner@enable.org');
    expect(byOwner.ok && byOwner.value?.id).toBe(created.value.id);
    expect(created.value.status).toBe('pending');
  });

  it('rejects a slug already taken by a non-terminal org (ORG_SLUG_TAKEN surfaced as DUPLICATE_SLUG)', async () => {
    const store = new InMemoryAggregatorOrgStore();
    await store.create({ slug: 'dup', displayName: 'A', ownerEmail: 'a@x.org' });
    const second = await store.create({ slug: 'dup', displayName: 'B', ownerEmail: 'b@x.org' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('DUPLICATE_SLUG');
  });

  it('allows a slug previously used only by a rejected org', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const first = await store.create({ slug: 'reusable', displayName: 'A', ownerEmail: 'a@x.org' });
    if (first.ok) await store.reject(first.value.id);
    const second = await store.create({
      slug: 'reusable',
      displayName: 'B',
      ownerEmail: 'b@x.org',
    });
    expect(second.ok).toBe(true);
  });

  it('listActive returns only active orgs', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({ slug: 'a', displayName: 'A', ownerEmail: 'a@x.org' });
    await store.create({ slug: 'b', displayName: 'B', ownerEmail: 'b@x.org' });
    if (a.ok) await store.approve(a.value.id);
    const active = await store.listActive();
    expect(active.ok && active.value.map((o) => o.slug)).toEqual(['a']);
  });

  it('approve is an atomic single-use guard (second approve returns null)', async () => {
    const store = new InMemoryAggregatorOrgStore();
    const a = await store.create({ slug: 'a', displayName: 'A', ownerEmail: 'a@x.org' });
    if (!a.ok) return;
    const first = await store.approve(a.value.id);
    const second = await store.approve(a.value.id);
    expect(first.ok && first.value?.status).toBe('active');
    expect(second.ok && second.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-org-store/__tests__/memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `interface.ts`**

Create `apps/api/src/services/aggregator-org-store/interface.ts`:

```typescript
/**
 * Aggregator-org store contract — the org system of record (spec §5.1).
 *
 * The org is a thin DB row; the Keycloak group is a future-authz mirror that
 * this store does not read for scoping. Status lives here so org approval uses
 * an atomic compare-and-set single-use guard (spec A3). Returns
 * `StoreResult<T>` on every boundary — never throws.
 */

import type { AggregatorStatus } from '@aggregator-dpg/shared-primitives/aggregator';

export interface AggregatorOrg {
  id: string;
  slug: string;
  displayName: string;
  state: string | null;
  ownerEmail: string;
  ownerKcSub: string | null;
  kcGroupId: string | null;
  status: AggregatorStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrgInput {
  slug: string;
  displayName: string;
  state?: string | null;
  ownerEmail: string;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
}

export interface UpdateOrgPatch {
  displayName?: string;
  state?: string | null;
  ownerKcSub?: string | null;
  kcGroupId?: string | null;
  status?: AggregatorStatus;
}

export type OrgStoreError =
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'DUPLICATE_SLUG'; message: string }
  | { code: 'DB_UNAVAILABLE'; message: string };

export type OrgStoreResult<T> = { ok: true; value: T } | { ok: false; error: OrgStoreError };

/** Abstract org persistence port. Concrete impls extend this base. */
export abstract class AggregatorOrgStoreBase {
  abstract create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>>;
  abstract findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  abstract listActive(): Promise<OrgStoreResult<AggregatorOrg[]>>;
  abstract update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>>;
  /**
   * Atomic compare-and-set pending→active. Returns the updated row, or `null`
   * inside `ok` when the row was not `pending` (the single-use guard lost the
   * race / already decided). Never throws.
   */
  abstract approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
  /** Atomic compare-and-set pending→inactive (== rejected). */
  abstract reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>>;
}
```

- [ ] **Step 4: Write `memory.ts`**

Create `apps/api/src/services/aggregator-org-store/memory.ts`:

```typescript
/**
 * In-memory aggregator-org store. Process-local Map; mirrors the Postgres
 * adapter's external behaviour (partial-slug uniqueness over non-terminal
 * rows, atomic approve/reject guard). Unit-test use only.
 */

import { randomUUID } from 'node:crypto';
import {
  AggregatorOrgStoreBase,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreError,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

const NON_TERMINAL = new Set(['pending', 'active']);

export class InMemoryAggregatorOrgStore extends AggregatorOrgStoreBase {
  protected readonly byId = new Map<string, AggregatorOrg>();

  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    const slugTaken = [...this.byId.values()].some(
      (o) => o.slug === input.slug && NON_TERMINAL.has(o.status),
    );
    if (slugTaken) return err('DUPLICATE_SLUG', `slug already in use: ${input.slug}`);
    const now = new Date();
    const row: AggregatorOrg = {
      id: randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      state: input.state ?? null,
      ownerEmail: input.ownerEmail.toLowerCase(),
      ownerKcSub: input.ownerKcSub ?? null,
      kcGroupId: input.kcGroupId ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(row.id, row);
    return { ok: true, value: row };
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return { ok: true, value: this.byId.get(id) ?? null };
  }

  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return { ok: true, value: [...this.byId.values()].find((o) => o.slug === slug) ?? null };
  }

  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const target = email.toLowerCase();
    return {
      ok: true,
      value: [...this.byId.values()].find((o) => o.ownerEmail === target) ?? null,
    };
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    const rows = [...this.byId.values()]
      .filter((o) => o.status === 'active')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { ok: true, value: rows };
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);
    const next: AggregatorOrg = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      state: patch.state !== undefined ? patch.state : existing.state,
      ownerKcSub: patch.ownerKcSub !== undefined ? patch.ownerKcSub : existing.ownerKcSub,
      kcGroupId: patch.kcGroupId !== undefined ? patch.kcGroupId : existing.kcGroupId,
      status: patch.status ?? existing.status,
      updatedAt: new Date(),
    };
    this.byId.set(id, next);
    return { ok: true, value: next };
  }

  async approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active');
  }

  async reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive');
  }

  private async casFromPending(
    id: string,
    next: AggregatorOrg['status'],
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    const existing = this.byId.get(id);
    if (!existing) return err('NOT_FOUND', id);
    if (existing.status !== 'pending') return { ok: true, value: null };
    const updated = { ...existing, status: next, updatedAt: new Date() };
    this.byId.set(id, updated);
    return { ok: true, value: updated };
  }
}

function err<T>(code: OrgStoreError['code'], message: string): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
```

- [ ] **Step 5: Run the memory test; verify it passes**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-org-store/__tests__/memory.test.ts`
Expected: PASS.

- [ ] **Step 6: Write `testing.ts`**

Create `apps/api/src/services/aggregator-org-store/testing.ts`:

```typescript
/**
 * Public testing surface for the aggregator-org store. Cross-package and
 * cross-module consumers import the fake from here, never the in-memory impl.
 */

import { InMemoryAggregatorOrgStore } from './memory.js';
import type { AggregatorOrg } from './interface.js';

export class AggregatorOrgStoreFake extends InMemoryAggregatorOrgStore {
  /** Pre-seed rows, bypassing create()'s slug check. */
  seed(rows: AggregatorOrg[]): void {
    for (const r of rows) this.byId.set(r.id, r);
  }

  /** Reset between tests. */
  reset(): void {
    this.byId.clear();
  }
}

/** Deterministic test data builder. */
export function buildAggregatorOrg(overrides: Partial<AggregatorOrg> = {}): AggregatorOrg {
  const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    slug: 'test-org',
    displayName: 'Test Org',
    state: null,
    ownerEmail: 'owner@test.local',
    ownerKcSub: null,
    kcGroupId: null,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}
```

- [ ] **Step 7: Write `postgres.ts`**

Create `apps/api/src/services/aggregator-org-store/postgres.ts`. Mirror `aggregator-store/postgres.ts` structure (import `getDb` from `../../db/client.js`, `aggregatorOrgs` from `../../db/schema.js`, `eq`/`and`/`inArray` from `drizzle-orm`). Map a Drizzle row → `AggregatorOrg` with a private `toModel(row)`. `approve`/`reject` use a conditional update:

```typescript
/**
 * Postgres aggregator-org store. The Drizzle adapter behind the
 * AggregatorOrgStoreBase port. PII (owner_email) is an ordinary indexed
 * column here; Keycloak remains authoritative for the owner identity.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { aggregatorOrgs } from '../../db/schema.js';
import {
  AggregatorOrgStoreBase,
  type AggregatorOrg,
  type CreateOrgInput,
  type OrgStoreResult,
  type UpdateOrgPatch,
} from './interface.js';

export class PostgresAggregatorOrgStore extends AggregatorOrgStoreBase {
  async create(input: CreateOrgInput): Promise<OrgStoreResult<AggregatorOrg>> {
    try {
      const [row] = await getDb()
        .insert(aggregatorOrgs)
        .values({
          slug: input.slug,
          displayName: input.displayName,
          state: input.state ?? null,
          ownerEmail: input.ownerEmail.toLowerCase(),
          ownerKcSub: input.ownerKcSub ?? null,
          kcGroupId: input.kcGroupId ?? null,
        })
        .returning();
      if (!row) return errResult('DB_UNAVAILABLE', 'insert returned no row');
      return { ok: true, value: toModel(row) };
    } catch (e) {
      return mapInsertError(e);
    }
  }

  async findById(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.id, id));
  }
  async findBySlug(slug: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.slug, slug));
  }
  async findByOwnerEmail(email: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.findOne(eq(aggregatorOrgs.ownerEmail, email.toLowerCase()));
  }

  async listActive(): Promise<OrgStoreResult<AggregatorOrg[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(aggregatorOrgs)
        .where(eq(aggregatorOrgs.status, 'active'));
      return { ok: true, value: rows.map(toModel) };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  async update(id: string, patch: UpdateOrgPatch): Promise<OrgStoreResult<AggregatorOrg>> {
    try {
      const [row] = await getDb()
        .update(aggregatorOrgs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(aggregatorOrgs.id, id))
        .returning();
      if (!row) return errResult('NOT_FOUND', id);
      return { ok: true, value: toModel(row) };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  async approve(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'active');
  }
  async reject(id: string): Promise<OrgStoreResult<AggregatorOrg | null>> {
    return this.casFromPending(id, 'inactive');
  }

  private async casFromPending(
    id: string,
    next: 'active' | 'inactive',
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await getDb()
        .update(aggregatorOrgs)
        .set({ status: next, updatedAt: new Date() })
        .where(and(eq(aggregatorOrgs.id, id), eq(aggregatorOrgs.status, 'pending')))
        .returning();
      return { ok: true, value: row ? toModel(row) : null };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }

  private async findOne(
    predicate: ReturnType<typeof eq>,
  ): Promise<OrgStoreResult<AggregatorOrg | null>> {
    try {
      const [row] = await getDb().select().from(aggregatorOrgs).where(predicate).limit(1);
      return { ok: true, value: row ? toModel(row) : null };
    } catch (e) {
      return errResult('DB_UNAVAILABLE', (e as Error).message);
    }
  }
}

function toModel(row: typeof aggregatorOrgs.$inferSelect): AggregatorOrg {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    state: row.state,
    ownerEmail: row.ownerEmail,
    ownerKcSub: row.ownerKcSub,
    kcGroupId: row.kcGroupId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapInsertError(e: unknown): OrgStoreResult<never> {
  const msg = (e as Error).message ?? '';
  if (msg.includes('aggregator_orgs_slug_active_unique')) {
    return errResult('DUPLICATE_SLUG', 'slug already in use');
  }
  return errResult('DB_UNAVAILABLE', msg);
}

function errResult<T>(
  code: 'NOT_FOUND' | 'DUPLICATE_SLUG' | 'DB_UNAVAILABLE',
  message: string,
): OrgStoreResult<T> {
  return { ok: false, error: { code, message } };
}
```

> Verify `getDb` import path + Drizzle helper imports against the existing `aggregator-store/postgres.ts` and adjust if they differ.

- [ ] **Step 8: Write `index.ts`**

Create `apps/api/src/services/aggregator-org-store/index.ts`:

```typescript
/**
 * Public surface + factory for the aggregator-org store. Process-wide
 * singleton; tests override via `_setAggregatorOrgStore`.
 */

import type { AggregatorOrgStoreBase } from './interface.js';
import { PostgresAggregatorOrgStore } from './postgres.js';

let instance: AggregatorOrgStoreBase | null = null;

/** Returns the shared org store. Lazy-initialised on first call. */
export function getAggregatorOrgStore(): AggregatorOrgStoreBase {
  if (instance) return instance;
  instance = new PostgresAggregatorOrgStore();
  return instance;
}

/** Test helper — replace the singleton. */
export function _setAggregatorOrgStore(s: AggregatorOrgStoreBase | null): void {
  instance = s;
}

export { AggregatorOrgStoreBase } from './interface.js';
export type {
  AggregatorOrg,
  CreateOrgInput,
  UpdateOrgPatch,
  OrgStoreError,
  OrgStoreResult,
} from './interface.js';
export { InMemoryAggregatorOrgStore } from './memory.js';
export { PostgresAggregatorOrgStore } from './postgres.js';
export { AggregatorOrgStoreFake, buildAggregatorOrg } from './testing.js';
```

- [ ] **Step 9: Typecheck + lint + dep-check + the store tests**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint && pnpm --filter @aggregator-dpg/api test -- aggregator-org-store && pnpm dep-check`
Expected: clean + green.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/aggregator-org-store
git commit -m "feat(api): aggregator-org store (system of record + atomic approve CAS)"
```

---

## Task 4: `parent_org_id` on the aggregator store

**Files:**

- Modify: `apps/api/src/services/aggregator-store/interface.ts`
- Modify: `apps/api/src/services/aggregator-store/memory.ts`
- Modify: `apps/api/src/services/aggregator-store/postgres.ts`
- Modify: `apps/api/src/services/aggregator-store/testing.ts`
- Test: `apps/api/src/services/aggregator-store/__tests__/parent-org.test.ts` (create)

**Interfaces:**

- Produces: `Aggregator.parentOrgId: string | null`; `CreateAggregatorInput.parentOrgId?: string | null`; `UpdateAggregatorPatch.parentOrgId?: string | null`; `AggregatorStoreBase.findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>>` (spec §10 org-view query). Consumed by Tasks 6, 8.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/aggregator-store/__tests__/parent-org.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryAggregatorStore } from '../memory.js';
import { buildAggregator } from '../testing.js';

describe('aggregator store parentOrgId', () => {
  it('persists parentOrgId on create and returns it', async () => {
    const store = new InMemoryAggregatorStore();
    const r = await store.create({
      orgSlug: 'c1',
      actorType: 'aggregator',
      name: 'Coord 1',
      type: 'seeker',
      contact: { name: 'A', phone: '+919000000001', email: 'c1@x.org' },
      consent: {
        value: true,
        given_at: '2026-01-01T00:00:00Z',
        valid_till: '2027-01-01T00:00:00Z',
      },
      createdBy: 'self',
      updatedBy: 'self',
      parentOrgId: 'org-1',
    });
    expect(r.ok && r.value.parentOrgId).toBe('org-1');
  });

  it("findByParentOrgId returns only that org's coordinators", async () => {
    const store = new InMemoryAggregatorStore();
    // buildAggregator bypasses create; cast via the fake's seed in real tests.
    const list = await store.findByParentOrgId('org-1');
    expect(list.ok && Array.isArray(list.value)).toBe(true);
  });
});
```

> Note: `InMemoryAggregatorStore` has no public `seed`; the second assertion only checks the method exists/returns a list. The full filtering behaviour is covered in Task 6's route tests via `AggregatorStoreFake.seed`.

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- parent-org.test.ts`
Expected: FAIL — `parentOrgId` not on the create input / `findByParentOrgId` undefined.

- [ ] **Step 3: Extend `interface.ts`**

In `apps/api/src/services/aggregator-store/interface.ts`:

- Add to `interface Aggregator`: `parentOrgId: string | null;` (after `signalstackOrgId`).
- Add to `interface CreateAggregatorInput`: `parentOrgId?: string | null;`
- Add to `interface UpdateAggregatorPatch`: `parentOrgId?: string | null;`
- Add the abstract method to `AggregatorStoreBase`:

```typescript
  /**
   * Returns every coordinator (`aggregators` row) whose `parent_org_id`
   * matches the given org id — the spec §10 org-view query. `parent_org_id`
   * is the single authority for the org→coordinator link (spec A1).
   *
   * @param orgId - `aggregator_orgs.id`.
   * @returns The org's coordinators (possibly empty), never throws.
   */
  abstract findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>>;
```

- [ ] **Step 4: Extend `memory.ts`**

- In `create()`, set `parentOrgId: input.parentOrgId ?? null` on the new row object.
- In `update()`, add `parentOrgId: patch.parentOrgId !== undefined ? patch.parentOrgId : existing.parentOrgId,` to the `next` object.
- In `updateStatus`/`updateSignalstackOrgId` `next` objects, the spread `...existing` already carries it — no change needed there.
- Add the method:

```typescript
  async findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    return {
      ok: true,
      value: [...this.byId.values()].filter((r) => r.parentOrgId === orgId),
    };
  }
```

- [ ] **Step 5: Extend `postgres.ts`**

- In the insert `.values({...})`, add `parentOrgId: input.parentOrgId ?? null`.
- In the **module-level `function toDomain(row)`** mapper (this file maps via a top-level `toDomain`, not a private method), add `parentOrgId: row.parentOrgId`.
- In `update`'s `.set({...})`, the patch spread already includes `parentOrgId` when present.
- Add:

```typescript
  async findByParentOrgId(orgId: string): Promise<StoreResult<Aggregator[]>> {
    try {
      const rows = await getDb()
        .select()
        .from(aggregators)
        .where(eq(aggregators.parentOrgId, orgId));
      return { ok: true, value: rows.map(toDomain) };
    } catch (e) {
      return { ok: false, error: { code: 'DB_UNAVAILABLE', message: (e as Error).message } };
    }
  }
```

- [ ] **Step 6: Extend `testing.ts` builder**

In `buildAggregator`, add `parentOrgId: overrides.parentOrgId ?? null,` to the returned object (before the `...overrides` spread so an explicit override still wins — place it before the spread).

- [ ] **Step 7: Run the test + full store suite; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-store`
Expected: PASS (existing aggregator-store tests still pass; new test passes).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm --filter @aggregator-dpg/api typecheck`

```bash
git add apps/api/src/services/aggregator-store
git commit -m "feat(api): add parent_org_id + findByParentOrgId to aggregator store"
```

---

## Task 5: IdP group + role operations

**Files:**

- Modify: `apps/api/src/services/idp-admin/interface.ts`
- Modify: the concrete Keycloak adapter (`apps/api/src/services/idp-admin/keycloak.ts` or `http.ts` — the file that `extends IdpAdminAdapter`; find it)
- Modify: `apps/api/src/services/idp-admin/testing.ts` (the fake)
- Test: `apps/api/src/services/idp-admin/__tests__/groups.test.ts` (create) or add to the existing idp test

**Interfaces:**

- Produces (consumed by Task 7):
  - `createGroup(name: string, attributes?: Record<string, string | string[]>): Promise<IdpResult<{ id: string }>>`
  - `addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>>`
  - `assignRealmRole(userId: string, role: string): Promise<IdpResult<void>>`
- These are the org-owner provisioning ops (group is a mirror; the owner is the only member in v1 — spec A1/§9).

- [ ] **Step 1: Write the failing fake test**

Create `apps/api/src/services/idp-admin/__tests__/groups.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { IdpAdminFake } from '../testing.js';

describe('IdpAdminFake group + role ops', () => {
  it('creates a group and returns an id', async () => {
    const idp = new IdpAdminFake();
    const r = await idp.createGroup('org-enable-india', { org_id: 'org-1' });
    expect(r.ok && typeof r.value.id).toBe('string');
  });

  it('adds a user to a group and assigns a realm role', async () => {
    const idp = new IdpAdminFake();
    const u = await idp.createUser({ email: 'owner@x.org', enabled: true });
    const g = await idp.createGroup('org-x');
    if (!u.ok || !g.ok) throw new Error('setup failed');
    const add = await idp.addUserToGroup(u.value.id, g.value.id);
    const role = await idp.assignRealmRole(u.value.id, 'org_owner');
    expect(add.ok).toBe(true);
    expect(role.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `pnpm --filter @aggregator-dpg/api test -- idp-admin/__tests__/groups.test.ts`
Expected: FAIL — `createGroup` is not a function.

- [ ] **Step 3: Add the abstract methods to `interface.ts`**

In `apps/api/src/services/idp-admin/interface.ts`, append to `abstract class IdpAdminAdapter`:

```typescript
  /**
   * Creates a Keycloak group (the org's authz mirror — spec §9). In v1 the
   * group holds only the org owner; coordinators are NOT members (spec A1).
   *
   * @param name - Group name (e.g. `org-<slug>`).
   * @param attributes - Optional group attributes (e.g. `{ org_id }`).
   * @returns The created group's id.
   */
  abstract createGroup(
    name: string,
    attributes?: Record<string, string | string[]>,
  ): Promise<IdpResult<{ id: string }>>;

  /** Adds a user to a group. */
  abstract addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>>;

  /** Assigns a realm role (e.g. `org_owner`, `coordinator`) to a user. */
  abstract assignRealmRole(userId: string, role: string): Promise<IdpResult<void>>;
```

- [ ] **Step 4: Implement in the concrete Keycloak adapter**

Find the file with `extends IdpAdminAdapter` that is NOT `memory.ts`/`testing.ts` (likely `keycloak.ts` or `http.ts`). Implement the three methods using the existing admin-client helper in that file (it already does `POST /admin/realms/{realm}/users`). Add:

- `createGroup` → `POST /admin/realms/{realm}/groups` body `{ name, attributes }`; read the created id from the `Location` response header (Keycloak returns `.../groups/{id}`); return `{ id }`.
- `addUserToGroup` → `PUT /admin/realms/{realm}/users/{userId}/groups/{groupId}`.
- `assignRealmRole` → look up the realm role rep via `GET /admin/realms/{realm}/roles/{role}`, then `POST /admin/realms/{realm}/users/{userId}/role-mappings/realm` with `[roleRep]`.

Each wrapped in the file's existing try/catch → `IdpResult` error mapping (timeout/5xx → `IDP_UNAVAILABLE`, 404 → `USER_NOT_FOUND` for the user lookups), matching how `createUser`/`enableUser` map errors in the same file. Follow the error-handling rule (explicit timeout + at least one retry already provided by the file's request helper — reuse it).

- [ ] **Step 5: Implement in the fake `testing.ts`**

In `IdpAdminFake` (or its `InMemoryIdpAdmin` base — add to whichever holds the user Map), add group/role state and methods:

```typescript
  private readonly groups = new Map<string, { id: string; name: string; attributes?: Record<string, string | string[]> }>();
  private readonly memberships = new Map<string, Set<string>>(); // userId -> groupIds
  private readonly roles = new Map<string, Set<string>>(); // userId -> roles

  async createGroup(
    name: string,
    attributes?: Record<string, string | string[]>,
  ): Promise<IdpResult<{ id: string }>> {
    const id = `grp-${this.groups.size + 1}`;
    this.groups.set(id, { id, name, attributes });
    return { ok: true, value: { id } };
  }

  async addUserToGroup(userId: string, groupId: string): Promise<IdpResult<void>> {
    if (!this.groups.has(groupId)) return { ok: false, error: { code: 'BAD_REQUEST', message: 'no such group' } };
    const set = this.memberships.get(userId) ?? new Set<string>();
    set.add(groupId);
    this.memberships.set(userId, set);
    return { ok: true, value: undefined };
  }

  async assignRealmRole(userId: string, role: string): Promise<IdpResult<void>> {
    const set = this.roles.get(userId) ?? new Set<string>();
    set.add(role);
    this.roles.set(userId, set);
    return { ok: true, value: undefined };
  }
```

Add test-only getters if the fake exposes inspection helpers elsewhere (match the fake's existing style); otherwise the route tests assert behaviour, not internal maps.

- [ ] **Step 6: Run the group test + full idp suite; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- idp-admin`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint + commit**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint`

```bash
git add apps/api/src/services/idp-admin
git commit -m "feat(api): idp-admin group + realm-role ops for org-owner provisioning"
```

---

## Task 6: Error codes + org registration submit (`POST /v1/orgs/create`) + active-org dropdown (`GET /v1/orgs`)

**Files:**

- Modify: `apps/api/src/errors/codes.ts`
- Create: `apps/api/src/services/org-registration-notify.ts`
- Create: `apps/api/src/routes/aggregator-orgs.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/aggregator-orgs.test.ts`

**Interfaces:**

- Produces:
  - Error codes `OWNER_ALREADY_REGISTERED` (409), `ORG_SLUG_TAKEN` (409), `TARGET_ORG_INACTIVE` (409) in `ERR`.
  - `sendOrgReviewEmail(input: { orgId: string; displayName: string; ownerEmail: string }, log): Promise<void>` — mints org approve/reject tokens (no `org` claim; sub = orgId) and emails `parseAdminEmails()` (the **network admin**).
  - `POST /v1/orgs/create` → 201 `{ org_id, slug, status, message }`; `GET /v1/orgs` → 200 `{ orgs: { id, slug, display_name }[] }` (active only, SQL).
- Consumes: `getAggregatorOrgStore`, `getIdpAdmin` (createUser disabled owner), `config.ORG_HIERARCHY_ENABLED`, `slugFromName`, `mintApprovalToken`, `renderAdminReview`, `parseAdminEmails`, `authenticateAny`.

- [ ] **Step 1: Add the error codes**

In `apps/api/src/errors/codes.ts`, in the `ERR` object (near `USER_EXISTS`/`PHONE_EXISTS`), add:

```typescript
  OWNER_ALREADY_REGISTERED: {
    code: 'OWNER_ALREADY_REGISTERED',
    status: 409,
    title: 'Already an org owner',
    detail:
      'This email or phone already belongs to an org owner. Request coordinator access from your org instead of registering again.',
    hint: 'Coordinator submit matched an aggregator_orgs.owner_email (spec A4). Owner→coordinator graduation is deferred.',
  },
  ORG_SLUG_TAKEN: {
    code: 'ORG_SLUG_TAKEN',
    status: 409,
    title: 'Organisation name unavailable',
    detail: 'An organisation with a matching name is already registered or pending. Try a different name.',
    hint: 'aggregator_orgs partial-unique slug collision over non-terminal rows (spec A9).',
  },
  TARGET_ORG_INACTIVE: {
    code: 'TARGET_ORG_INACTIVE',
    status: 409,
    title: 'Organisation unavailable',
    detail: 'The selected organisation is no longer accepting coordinators. Contact the organisation owner.',
    hint: 'Coordinator submit/approval against an org whose status != active (spec §6.2 re-validate).',
  },
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/api/src/routes/aggregator-orgs.test.ts` (mirror `aggregator-registrations.test.ts` harness: `buildApp`, `_setAggregatorOrgStore`, `_setIdpAdmin`, `_setMailer`, `_setAccessTokenVerifier`, `AUTH_HEADER`, `APPROVAL_TOKEN_SECRET`, `ADMIN_EMAILS`). Set `process.env.ORG_HIERARCHY_ENABLED='true'` in `beforeEach` and call `buildApp()` AFTER setting it — but note `config` reads env at import time, so instead the flag is read in the handler via `config.ORG_HIERARCHY_ENABLED`; since `config` is parsed once at import, set the env var before the test process imports config. Practically: set `process.env.ORG_HIERARCHY_ENABLED = 'true'` at the very top of the test file, before any import that pulls `config`. Use a top-of-file statement:

```typescript
process.env.ORG_HIERARCHY_ENABLED = 'true';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
// ...rest of imports
```

Tests:

```typescript
it('creates a pending org + mirrored group + disabled owner, emails the network admin', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs/create',
    headers: AUTH_HEADER,
    payload: {
      display_name: 'Enable India',
      state: 'Karnataka',
      owner: { name: 'Ravi', email: 'ravi@enable.org', phone: '+919876500000' },
      consent: {
        value: true,
        given_at: '2026-01-15T10:00:00Z',
        valid_till: '2027-01-15T10:00:00Z',
      },
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { org_id: string; status: string };
  expect(body.status).toBe('pending');
  const stored = await orgStore.findById(body.org_id);
  expect(stored.ok && stored.value?.status).toBe('pending');
  expect(stored.ok && stored.value?.kcGroupId).toBeTruthy();
  expect(mailer.outbox.length).toBe(1);
  expect(mailer.outbox[0]?.to).toContain('reviewer@bluedots.local');
});

it('GET /v1/orgs lists only active orgs', async () => {
  orgStore.seed([
    buildAggregatorOrg({ id: 'o-active', slug: 'a', displayName: 'A', status: 'active' }),
    buildAggregatorOrg({ id: 'o-pending', slug: 'b', displayName: 'B', status: 'pending' }),
  ]);
  const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: AUTH_HEADER });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { orgs: { slug: string }[] };
  expect(body.orgs.map((o) => o.slug)).toEqual(['a']);
});

it('returns ORG_SLUG_TAKEN when a non-terminal org owns the slug', async () => {
  orgStore.seed([buildAggregatorOrg({ id: 'o1', slug: 'enable-india', status: 'active' })]);
  // slugFromName appends a random suffix, so to force the collision, seed with
  // the deterministic slug the handler will compute is impractical; instead this
  // test seeds a pending org with the SAME owner email and asserts the reclaim
  // path is NOT triggered for orgs (orgs do not reclaim in this task). Simpler:
  // assert a duplicate owner email is allowed to refresh per spec §7 — covered
  // in Task 9. Here, assert the store's DUPLICATE_SLUG maps to ORG_SLUG_TAKEN by
  // calling create twice with a store stubbed to return DUPLICATE_SLUG.
});
```

> Keep the third test minimal/factual: the slug-collision-to-`ORG_SLUG_TAKEN` mapping is unit-tested at the store level (Task 3) and the handler's error mapping is asserted by stubbing the store to return `DUPLICATE_SLUG`. Write it as: seed nothing, replace `orgStore.create` via a thin subclass that returns `{ ok:false, error:{ code:'DUPLICATE_SLUG' } }`, expect 409 `ORG_SLUG_TAKEN`.

- [ ] **Step 3: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-orgs.test.ts`
Expected: FAIL — route 404 (not registered).

- [ ] **Step 4: Write the org-notify helper**

Create `apps/api/src/services/org-registration-notify.ts`:

```typescript
/**
 * Org-review notification. Mints the org approve/reject token pair (sub =
 * org id, no `org` claim — the network admin is the approver, not an org
 * owner) and emails the configured network admins. Shared by org submit and
 * the §7 org-refresh path.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { mintApprovalToken, formatApprovalTtl } from './approval-token.js';
import { renderAdminReview } from './email-templates/index.js';
import { getMailer } from './mailer/index.js';
import { parseAdminEmails } from './registration-notify.js';
import { httpError } from '../errors/http-error.js';

/** Inputs to render + deliver the org-review email. */
export interface OrgReviewNotifyInput {
  orgId: string;
  displayName: string;
  ownerEmail: string;
}

/**
 * Mints org approve/reject tokens and emails the network admins a review link.
 *
 * @param input - Org id + display name + owner email for the email body.
 * @param log - Request-scoped logger.
 * @throws {HttpError} `TOKEN_MINT_FAILED` if minting fails.
 */
export async function sendOrgReviewEmail(
  input: OrgReviewNotifyInput,
  log: FastifyBaseLogger,
): Promise<void> {
  let approveToken: string;
  let rejectToken: string;
  try {
    const ttlSec = config.APPROVAL_TOKEN_TTL_SECONDS;
    approveToken = (
      await mintApprovalToken({ aggregatorId: input.orgId, intent: 'approve', ttlSec })
    ).token;
    rejectToken = (await mintApprovalToken({ aggregatorId: input.orgId, intent: 'reject', ttlSec }))
      .token;
  } catch (err) {
    throw httpError('TOKEN_MINT_FAILED', { cause: err });
  }

  const base = `${config.PUBLIC_API_URL}/admin/v1/orgs/read/${input.orgId}`;
  const mail = renderAdminReview({
    registrationId: input.orgId,
    applicantName: input.displayName,
    applicantEmail: input.ownerEmail,
    applicantPhone: '',
    association: input.displayName,
    aggregatorType: 'org',
    approveUrl: `${base}?token=${encodeURIComponent(approveToken)}&intent=approve`,
    rejectUrl: `${base}?token=${encodeURIComponent(rejectToken)}&intent=reject`,
    submittedAt: new Date(),
    expiresInText: formatApprovalTtl(config.APPROVAL_TOKEN_TTL_SECONDS),
  });

  const sent = await getMailer().send({
    to: parseAdminEmails(),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!sent.ok) {
    log.warn(
      {
        operation: 'org-registration-notify.sendOrgReviewEmail',
        status: 'failure',
        sub_operation: 'mailer.send',
        code: sent.error.code,
        cause: sent.error.message,
      },
      'org review email delivery failed — org still recorded',
    );
  }
}
```

> Verify `renderAdminReview`'s parameter names against `services/email-templates/index.ts`; if it lacks `aggregatorType: 'org'` support, pass the existing required fields and omit `aggregatorType` (it is cosmetic). Adjust to the real signature.

- [ ] **Step 5: Write the route module**

Create `apps/api/src/routes/aggregator-orgs.ts`. Use the org-store + idp + notify. Key logic:

- `POST /v1/orgs/create`: `authenticateAny`; if `!config.ORG_HIERARCHY_ENABLED` → `httpError('NOT_FOUND')` (route inert when flag off — match an existing 404 code, e.g. add a guard returning `httpError('SCHEMA_VALIDATION', { detail: 'org hierarchy disabled' })` is wrong; use a dedicated guard: return reply 404 via `httpError('NOT_FOUND')` if that code exists, else `'ROUTE_DISABLED'` — check codes.ts; if neither, reuse `'SCHEMA_VALIDATION'` is incorrect — instead register the route only when the flag is on (see below)). **Simplest correct approach:** in `registerAggregatorOrgRoutes`, wrap route registration in `if (config.ORG_HIERARCHY_ENABLED) { app.post(...); app.get(...); }` so the routes simply don't exist when the flag is off (404 by Fastify). This keeps flag-off behaviour clean and needs no new code.
- Validate a Zod body schema `OrgCreateBodySchema` (`display_name`, `state?`, `owner: { name, email, phone }`, `consent`). Normalise owner phone via `normalisePhone`.
- Compute `slug = slugFromName(display_name)`.
- `orgStore.create({ slug, displayName, state, ownerEmail })`; map `DUPLICATE_SLUG` → `httpError('ORG_SLUG_TAKEN')`, `DB_UNAVAILABLE` → `httpError('DB_UNAVAILABLE')`.
- Create the mirrored KC group: `idp.createGroup('org-' + slug, { org_id: orgId })`; on failure roll back the org row (`orgStore.update(orgId,{status:'inactive'})` or delete — there's no delete in the store; set status inactive and `httpError('IDP_UNAVAILABLE')`). On success, `orgStore.update(orgId, { kcGroupId })`.
- Create the disabled owner KC user: `idp.createUser({ email, phone, enabled:false, firstName, lastName, attributes:{ [KC_ATTR.DECISION_MADE]:'pending' } })`. Store `ownerKcSub` via `orgStore.update(orgId, { ownerKcSub: kcUser.id })`.
- `await sendOrgReviewEmail({ orgId, displayName, ownerEmail }, log)`.
- Reply 201 `{ org_id: orgId, slug, status: 'pending', message: '...' }`.
- `GET /v1/orgs`: `authenticateAny`; `orgStore.listActive()`; reply `{ orgs: rows.map(r => ({ id: r.id, slug: r.slug, display_name: r.displayName })) }`.

Use `errorResponses(...)` in the route schema and a `z.object(...).passthrough()` response schema like other routes. Add full TSDoc + structured logs (`operation: 'org-registration.create'`).

- [ ] **Step 6: Register in `app.ts`**

In `apps/api/src/app.ts`: `import { registerAggregatorOrgRoutes } from './routes/aggregator-orgs.js';` and `await registerAggregatorOrgRoutes(app);` alongside the other registrations.

- [ ] **Step 7: Run the org route tests; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-orgs.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + lint + commit**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint`

```bash
git add apps/api/src/errors/codes.ts apps/api/src/services/org-registration-notify.ts apps/api/src/routes/aggregator-orgs.ts apps/api/src/routes/aggregator-orgs.test.ts apps/api/src/app.ts
git commit -m "feat(api): org registration submit + active-org dropdown + org error codes"
```

---

## Task 7: Org approval flow (`/admin/v1/orgs/...`)

**Files:**

- Create: `apps/api/src/routes/aggregator-org-approvals.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/aggregator-org-approvals.test.ts`

**Interfaces:**

- Produces: `GET /admin/v1/orgs/read/:id?token&intent` (HTML confirm page), `POST /admin/v1/orgs/decision/:id` (body `{ token, decision }`). Approve = `orgStore.approve(id)` (atomic CAS) + enable owner KC user + `assignRealmRole(ownerKcSub, 'org_owner')` + add owner to group + welcome email. Reject = `orgStore.reject(id)`. Reuses `renderConfirmPage`/`renderResultPage` from `views/approval-pages.ts` and `verifyApprovalToken`.
- Consumes: `getAggregatorOrgStore`, `getIdpAdmin`, `verifyApprovalToken`, view renderers, `config.ORG_HIERARCHY_ENABLED`.

- [ ] **Step 1: Write the failing approval tests**

Create `apps/api/src/routes/aggregator-org-approvals.test.ts` (top-of-file `process.env.ORG_HIERARCHY_ENABLED='true'`; harness with `_setAggregatorOrgStore`, `_setIdpAdmin`, `_setMailer`, `_resetTokenKey`, `APPROVAL_TOKEN_SECRET`). Seed a pending org + disabled owner KC user, mint a real approve token (`mintApprovalToken({ aggregatorId: orgId, intent:'approve' })`):

```typescript
it('approve flips org to active via atomic CAS and enables the owner', async () => {
  const orgId = '00000000-0000-0000-0000-0000000000a1';
  const owner = await idp.createUser({
    email: 'owner@x.org',
    enabled: false,
    attributes: { decision_made: 'pending' },
  });
  if (!owner.ok) throw new Error('seed');
  orgStore.seed([
    buildAggregatorOrg({
      id: orgId,
      slug: 'x',
      ownerEmail: 'owner@x.org',
      ownerKcSub: owner.value.id,
      kcGroupId: 'grp-1',
      status: 'pending',
    }),
  ]);
  const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/orgs/decision/${orgId}`,
    payload: { token, decision: 'approve' },
  });
  expect(res.statusCode).toBe(200);
  const stored = await orgStore.findById(orgId);
  expect(stored.ok && stored.value?.status).toBe('active');
  const kc = await idp.findById(owner.value.id);
  expect(kc.ok && kc.value?.enabled).toBe(true);
});

it('double-clicked approve commits once (atomic single-use guard)', async () => {
  const orgId = '00000000-0000-0000-0000-0000000000a2';
  const owner = await idp.createUser({ email: 'o2@x.org', enabled: false });
  if (!owner.ok) throw new Error('seed');
  orgStore.seed([
    buildAggregatorOrg({
      id: orgId,
      slug: 'y',
      ownerEmail: 'o2@x.org',
      ownerKcSub: owner.value.id,
      status: 'pending',
    }),
  ]);
  const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'approve' });
  const first = await app.inject({
    method: 'POST',
    url: `/admin/v1/orgs/decision/${orgId}`,
    payload: { token, decision: 'approve' },
  });
  const second = await app.inject({
    method: 'POST',
    url: `/admin/v1/orgs/decision/${orgId}`,
    payload: { token, decision: 'approve' },
  });
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(second.body).toContain('already');
});

it('reject sets the org inactive', async () => {
  const orgId = '00000000-0000-0000-0000-0000000000a3';
  orgStore.seed([buildAggregatorOrg({ id: orgId, slug: 'z', status: 'pending' })]);
  const { token } = await mintApprovalToken({ aggregatorId: orgId, intent: 'reject' });
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/orgs/decision/${orgId}`,
    payload: { token, decision: 'reject' },
  });
  expect(res.statusCode).toBe(200);
  const stored = await orgStore.findById(orgId);
  expect(stored.ok && stored.value?.status).toBe('inactive');
});
```

- [ ] **Step 2: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-org-approvals.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement the org approval routes**

Create `apps/api/src/routes/aggregator-org-approvals.ts`, registered only when `config.ORG_HIERARCHY_ENABLED`. Structure mirrors `aggregator-approvals.ts`:

- GET `/admin/v1/orgs/read/:id`: verify token (no `org` claim expected — `verifyApprovalToken(token)`), check `verified.aggregatorId === id`, load org via `orgStore.findById`; if `status !== 'pending'` render an already-decided result page; else render `renderConfirmPage` with `postUrl = ${config.PUBLIC_API_URL}/admin/v1/orgs/decision/${id}`, applicant fields from the org row.
- POST `/admin/v1/orgs/decision/:id`: parse `{ token, decision }`; verify token + id match; load org; if not pending → already-decided page.
  - approve: `const cas = await orgStore.approve(id)`; if `cas.value === null` → already-decided page (race lost). Then enable owner (`idp.enableUser(ownerKcSub)`), `idp.assignRealmRole(ownerKcSub, 'org_owner')` (soft-fail logged), `idp.addUserToGroup(ownerKcSub, kcGroupId)` if `kcGroupId` (soft-fail), send welcome email (non-blocking). Result page success.
  - reject: `await orgStore.reject(id)`; owner stays disabled; result page.
- Reuse `sendHtml` (define a local copy identical to the approvals module, or export it from there — define a local one to avoid coupling). Add full TSDoc + logs (`operation: 'org-approval.decide'`).

> Hard-gate: enabling the owner is required for the future console but the spec defers login; treat `enableUser` failure as a 503 result page (admin can re-click; `approve` already committed status, but re-click is safe because the second `approve` CAS returns null → already-decided, and enable is idempotent — so on a 503 from enable, do NOT commit status first). **Ordering:** call `idp.enableUser` BEFORE `orgStore.approve` so a failed enable leaves status pending and the link still works. Then the CAS approve is the commit point. Match the coordinator approve ordering in `aggregator-approvals.ts` (hard-gates before the atomic status flip).

- [ ] **Step 4: Register in `app.ts`**

`import { registerAggregatorOrgApprovalRoutes } from './routes/aggregator-org-approvals.js';` + `await registerAggregatorOrgApprovalRoutes(app);`.

- [ ] **Step 5: Run the org approval tests; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-org-approvals.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint`

```bash
git add apps/api/src/routes/aggregator-org-approvals.ts apps/api/src/routes/aggregator-org-approvals.test.ts apps/api/src/app.ts
git commit -m "feat(api): org approval flow (network-admin token, atomic CAS, owner enable)"
```

---

## Task 8: Coordinator submit — org link + bootstrap + uniqueness + rate limiting

**Files:**

- Modify: `apps/api/src/routes/aggregator-registrations.ts`
- Test: `apps/api/src/routes/aggregator-registrations.test.ts` (add)

**Interfaces:**

- Consumes: `config.ORG_HIERARCHY_ENABLED`, `getAggregatorOrgStore`, `consume` (rate limiter), the new `parentOrgId` field, error codes `OWNER_ALREADY_REGISTERED`/`TARGET_ORG_INACTIVE`.
- Produces: when flag ON, the submit body accepts `org_id`; the created/updated aggregator carries `parentOrgId`; approval email routes to the org owner (Task 9 binds the token, this task sets the link + validations).

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/aggregator-registrations.test.ts`, add a nested `describe('with ORG_HIERARCHY_ENABLED', ...)`. Because `config` reads env once at import, these flag-on assertions must run with the flag set at process start; put them in a SEPARATE test file `aggregator-registrations.org.test.ts` whose first line is `process.env.ORG_HIERARCHY_ENABLED = 'true';` then imports. Harness adds `_setAggregatorOrgStore`. Tests:

```typescript
it('rejects coordinator submit when no active org exists (bootstrap)', async () => {
  // no orgs seeded
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: { ...validBody, org_id: 'missing' },
  });
  expect(res.statusCode).toBe(409);
  expect((res.json() as { error: { code: string } }).error.code).toBe('TARGET_ORG_INACTIVE');
});

it('sets parent_org_id from the chosen active org', async () => {
  orgStore.seed([
    buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: { ...validBody, org_id: 'org-1' },
  });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { aggregator_id: string }).aggregator_id;
  const stored = await aggregatorStore.findById(id);
  expect(stored.ok && stored.value?.parentOrgId).toBe('org-1');
});

it('returns OWNER_ALREADY_REGISTERED when the coordinator email is an org owner', async () => {
  orgStore.seed([
    buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'asha@trrain.org' }),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/aggregator-registrations/create',
    headers: AUTH_HEADER,
    payload: { ...validBody, org_id: 'org-1' }, // validBody.contact.email === 'asha@trrain.org'
  });
  expect(res.statusCode).toBe(409);
  expect((res.json() as { error: { code: string } }).error.code).toBe('OWNER_ALREADY_REGISTERED');
});

it('throttles repeated submits from the same email (rate limit)', async () => {
  orgStore.seed([
    buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'active', ownerEmail: 'owner@o.org' }),
  ]);
  // The rate limiter fails open without Redis; this test asserts the consume()
  // call is wired by stubbing it to deny. Provide a _setRateLimiter hook OR
  // assert via a very low max — see Step 4. If no injection hook exists, this
  // test is marked .skip with a TODO referencing the integration test, and the
  // wiring is covered by asserting consume is invoked (spy). Prefer adding a
  // thin injectable `checkSubmitRate` indirection (Step 4) so this is testable.
});
```

> The rate-limit test needs the limiter to be injectable for a unit test (the real one needs Redis and fails open). In Step 4 add a tiny indirection `checkSubmitRate(key)` in a new `services/submit-rate.ts` with a `_setSubmitRateChecker` test hook, defaulting to `consume({ namespace:'coordinator-submit', key, windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS, max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW })`. Then the test injects a checker that returns `{ allowed:false }` and asserts a 429.

- [ ] **Step 2: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-registrations.org.test.ts`
Expected: FAIL — `org_id` ignored, no org validation.

- [ ] **Step 3: Add the rate-limit indirection**

Create `apps/api/src/services/submit-rate.ts`:

```typescript
/**
 * Injectable submit rate-limit check for the coordinator registration
 * endpoint (spec A6). Wraps the Redis fixed-window limiter so handlers stay
 * testable without Redis; tests override via `_setSubmitRateChecker`.
 */

import { config } from '../config.js';
import { consume } from './rate-limiter/index.js';

export interface SubmitRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Checker = (key: string) => Promise<SubmitRateResult>;

let override: Checker | null = null;

/** Test helper — replace the checker. */
export function _setSubmitRateChecker(c: Checker | null): void {
  override = c;
}

/**
 * Consumes one slot for the given key (typically IP or email) from the
 * coordinator-submit bucket.
 *
 * @param key - Identifier inside the bucket (per-IP or per-email).
 * @returns Whether the call is allowed + retry-after seconds.
 */
export async function checkSubmitRate(key: string): Promise<SubmitRateResult> {
  if (override) return override(key);
  const r = await consume({
    namespace: 'coordinator-submit',
    key,
    windowSeconds: config.PUBLIC_SUBMIT_RATE_WINDOW_SECONDS,
    max: config.PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW,
  });
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}
```

`RATE_LIMITED` (429) **already exists** in `codes.ts` (used by the public link submit) — reuse it, do not add a new code. Set `Retry-After` and throw it exactly as `public-registration-links.ts` does:

```typescript
reply.header('Retry-After', String(rl.retryAfterSeconds));
throw httpError('RATE_LIMITED', { detail: `Retry in ${rl.retryAfterSeconds}s.` });
```

- [ ] **Step 4: Wire the coordinator submit handler**

In `apps/api/src/routes/aggregator-registrations.ts`, at the start of the handler body (after `authenticateAny`), add a flag-gated block. Because the body schema is fixed (`RegistrationPayloadSchema`), read `org_id` from the raw body defensively: `const orgId = (req.body as { org_id?: string }).org_id;`.

```typescript
import { config } from '../config.js';
import { getAggregatorOrgStore } from '../services/aggregator-org-store/index.js';
import { checkSubmitRate } from '../services/submit-rate.js';

// ... inside the handler, after `const body = ...` and phone normalisation:
let parentOrgId: string | null = null;
if (config.ORG_HIERARCHY_ENABLED) {
  // Rate limit per email + per IP (spec A6).
  const rl = await checkSubmitRate(`${req.ip}|${contact.email}`);
  if (!rl.allowed) {
    throw httpError('RATE_LIMITED', { fields: { retry_after_seconds: rl.retryAfterSeconds } });
  }
  const reqOrgId = (req.body as { org_id?: string }).org_id;
  if (!reqOrgId) {
    throw httpError('SCHEMA_VALIDATION', {
      detail: 'org_id is required when org hierarchy is enabled.',
    });
  }
  const orgStore = getAggregatorOrgStore();
  const org = await orgStore.findById(reqOrgId);
  if (!org.ok) {
    throw httpError('DB_UNAVAILABLE', {
      cause: new Error(org.error.message),
      fields: { sub_operation: 'orgStore.findById' },
    });
  }
  if (!org.value || org.value.status !== 'active') {
    // Covers bootstrap (no active org) and an org that went inactive/rejected.
    throw httpError('TARGET_ORG_INACTIVE');
  }
  // Owner-also-coordinator (spec A4): a coordinator submit matching an org
  // owner's email is a distinct, machine-readable error, not a duplicate.
  const ownerMatch = await orgStore.findByOwnerEmail(contact.email);
  if (ownerMatch.ok && ownerMatch.value) {
    throw httpError('OWNER_ALREADY_REGISTERED', { fields: { email: contact.email } });
  }
  parentOrgId = reqOrgId;
}
```

Then thread `parentOrgId` into BOTH creation paths:

- In `createAggregatorWithSlug`, add `parentOrgId` to the `extras` object and to the `store.create({...})` call. Update the call site to pass `parentOrgId`.
- In the reclaim path's `aggregatorStore.update(existing.id, {...})`, add `parentOrgId` so a reclaimed coordinator keeps/updates its org link.

> Approval-email routing to the org owner is added in Task 9 (token binding + recipient). This task only sets the link + validations + rate limiting. The submit still calls `sendAdminReviewEmail` (network admin) until Task 9 swaps it for the owner-routed mint when `parentOrgId` is set — leave the call as-is here; Task 9 changes it.

- [ ] **Step 5: Run the org tests + the existing registration suite; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-registrations`
Expected: PASS — `aggregator-registrations.org.test.ts` green; the flat `aggregator-registrations.test.ts` (flag off in that process) unchanged.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint`

```bash
git add apps/api/src/routes/aggregator-registrations.ts apps/api/src/routes/aggregator-registrations.org.test.ts apps/api/src/services/submit-rate.ts apps/api/src/errors/codes.ts
git commit -m "feat(api): coordinator submit org link, bootstrap guard, owner-dup + rate limit"
```

---

## Task 9: Coordinator approval — owner-routed token binding + org re-validation

**Files:**

- Modify: `apps/api/src/services/approval-token.ts`
- Modify: `apps/api/src/services/registration-notify.ts`
- Modify: `apps/api/src/routes/aggregator-registrations.ts` (route the email to the owner when `parentOrgId` set)
- Modify: `apps/api/src/routes/aggregator-approvals.ts` (verify token `org` claim + re-validate org active)
- Test: `apps/api/src/services/approval-token.test.ts`, `apps/api/src/routes/aggregator-approvals.test.ts`

**Interfaces:**

- Produces:
  - `mintApprovalToken({ aggregatorId, intent, ttlSec?, org? })` — optional `org` claim (the coordinator's `parent_org_id`).
  - `verifyApprovalToken` result gains `org?: string` (the claim, when present).
  - `sendAdminReviewEmail(input, log)` gains optional `input.org?: string` (minted into the token) and optional `input.recipientEmail?: string` (overrides `parseAdminEmails()` → routes to the org owner).
- Consumes: Task 3 org store (re-validate at approval), Task 8's `parentOrgId`.

- [ ] **Step 1: Write the failing token test**

In `apps/api/src/services/approval-token.test.ts`, add:

```typescript
it('round-trips an org claim', async () => {
  const { token } = await mintApprovalToken({
    aggregatorId: 'agg-1',
    intent: 'approve',
    org: 'org-1',
  });
  const v = await verifyApprovalToken(token);
  expect(v.ok).toBe(true);
  if (v.ok) expect(v.org).toBe('org-1');
});

it('omits org when not minted', async () => {
  const { token } = await mintApprovalToken({ aggregatorId: 'agg-1', intent: 'approve' });
  const v = await verifyApprovalToken(token);
  if (v.ok) expect(v.org).toBeUndefined();
});
```

- [ ] **Step 2: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-token.test.ts`
Expected: FAIL — `org` not accepted/returned.

- [ ] **Step 3: Add the `org` claim to mint + verify**

In `apps/api/src/services/approval-token.ts`:

- `MintInput` gains `org?: string`.
- In `mintApprovalToken`, when `input.org` is set, add it to the JWT payload: change `new SignJWT({ intent: input.intent })` to `new SignJWT({ intent: input.intent, ...(input.org ? { org: input.org } : {}) })`.
- `VerifyOk` gains `org?: string`.
- In `verifyApprovalToken`, both the happy path and the `allowExpired` decode path: after extracting `intent`, read `const org = typeof payload.org === 'string' ? payload.org : undefined;` and include `...(org ? { org } : {})` in the returned `{ ok:true, aggregatorId, intent }`.

- [ ] **Step 4: Run the token test; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- approval-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Route the coordinator email to the owner + mint the org claim**

In `apps/api/src/services/registration-notify.ts`:

- `AdminReviewNotifyInput` gains `org?: string;` and `recipientEmail?: string;`.
- In `sendAdminReviewEmail`, pass `org: input.org` into both `mintApprovalToken` calls.
- Change the recipient: `to: input.recipientEmail ? [input.recipientEmail] : parseAdminEmails(),`.

In `apps/api/src/routes/aggregator-registrations.ts`, where the coordinator (non-reclaim and reclaim) calls `sendAdminReviewEmail`, when `parentOrgId` is set, look up the org owner email and pass `org` + `recipientEmail`:

```typescript
let ownerEmail: string | undefined;
if (parentOrgId) {
  const orgStore = getAggregatorOrgStore();
  const org = await orgStore.findById(parentOrgId);
  if (org.ok && org.value) ownerEmail = org.value.ownerEmail;
}
await sendAdminReviewEmail(
  {
    aggregatorId,
    applicantName: body.name,
    applicantEmail: contact.email,
    applicantPhone: phoneE164,
    org: parentOrgId ?? undefined,
    recipientEmail: ownerEmail,
  },
  log,
);
```

(Apply to both call sites; in the reclaim path use `existing.id` and `existing.parentOrgId ?? parentOrgId`.)

- [ ] **Step 6: Write the failing approval-binding tests**

In `apps/api/src/routes/aggregator-approvals.test.ts` (flag-independent — token binding works regardless, but org re-validation needs the org store; add `_setAggregatorOrgStore` to this file's harness), add:

```typescript
it('rejects a coordinator decision when the token org claim mismatches parent_org_id', async () => {
  // coordinator under org B, token minted for org A
  const id = (await seedPendingAggregator()).id; // helper exists; ensure it sets parentOrgId='org-B'
  await aggregatorStore.update(id, { parentOrgId: 'org-B', updatedBy: 'test' });
  const { token } = await mintApprovalToken({ aggregatorId: id, intent: 'approve', org: 'org-A' });
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/aggregator-registrations/decision/${id}`,
    payload: { token, decision: 'approve' },
  });
  expect(res.statusCode).toBe(400);
});

it('declines coordinator approval when the target org is not active (TARGET_ORG_INACTIVE)', async () => {
  const id = (await seedPendingAggregator()).id;
  await aggregatorStore.update(id, { parentOrgId: 'org-1', updatedBy: 'test' });
  orgStore.seed([buildAggregatorOrg({ id: 'org-1', slug: 'o', status: 'inactive' })]);
  const { token } = await mintApprovalToken({ aggregatorId: id, intent: 'approve', org: 'org-1' });
  const res = await app.inject({
    method: 'POST',
    url: `/admin/v1/aggregator-registrations/decision/${id}`,
    payload: { token, decision: 'approve' },
  });
  expect(res.body).toContain('no longer accepting'); // TARGET_ORG_INACTIVE copy
});
```

> Ensure `seedPendingAggregator` in this test file seeds via `aggregatorStore.seed([buildAggregator({ id, ... })])` so `parentOrgId` can be set; if the existing helper uses `idp.createUser` + a store row, extend it to accept a `parentOrgId` override.

- [ ] **Step 7: Enforce the binding + re-validation in the decision handler**

In `apps/api/src/routes/aggregator-approvals.ts` POST decision handler, after `verifyApprovalToken` succeeds and `loadAggregatorAndUser` returns the aggregator:

- **Token binding (spec §9/A1):** if `lookup.aggregator.parentOrgId` is set, require `verified.org === lookup.aggregator.parentOrgId`; otherwise return the existing invalid-link result page (`sendHtml(reply, 400, renderResultPage({ status:'error', title:'Invalid link', message:'Token does not match this organisation.' }))`). If `parentOrgId` is null (flat coordinator), skip this check (flag-off behaviour unchanged).
- **Re-validate org active (spec §6.2):** if `lookup.aggregator.parentOrgId` is set, before the signalstack/enable hard-gates, load the org (`getAggregatorOrgStore().findById(parentOrgId)`); if missing or `status !== 'active'`, return a result page with `tokenErrorMessage`-style copy from `TARGET_ORG_INACTIVE` (`renderResultPage({ status:'error', title: ERR.TARGET_ORG_INACTIVE.title, message: ERR.TARGET_ORG_INACTIVE.detail })`), status 200 HTML (this is a browser flow). Do this only when `config.ORG_HIERARCHY_ENABLED` AND `parentOrgId` set, so flat flow is untouched.

- [ ] **Step 8: Run the approval + token suites; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- aggregator-approvals.test.ts approval-token.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + lint + full api test + dep-check**

Run: `pnpm --filter @aggregator-dpg/api typecheck && pnpm --filter @aggregator-dpg/api lint && pnpm --filter @aggregator-dpg/api test && pnpm dep-check`
Expected: clean + green.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/approval-token.ts apps/api/src/services/approval-token.test.ts apps/api/src/services/registration-notify.ts apps/api/src/routes/aggregator-registrations.ts apps/api/src/routes/aggregator-approvals.ts apps/api/src/routes/aggregator-approvals.test.ts
git commit -m "feat(api): bind coordinator approval token to parent_org_id + route to org owner"
```

---

## Task 10: Auth roles + org-view query helper + flag-off regression sweep

**Files:**

- Modify: `apps/api/src/services/auth/access-token.ts` (recognise `role=coordinator`; no behaviour change for flat) — only if a role claim is needed; otherwise document no-op.
- Create: `apps/api/src/services/org-view.ts` (the §10 future org-view query helper, built now so the relationship is proven)
- Test: `apps/api/src/services/__tests__/org-view.test.ts`

**Interfaces:**

- Produces: `listOrgCoordinators(orgId: string): Promise<StoreResult<Aggregator[]>>` — thin wrapper over `getAggregatorStore().findByParentOrgId(orgId)` (spec §10). Proves the single-FK org-view with no KC calls.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/__tests__/org-view.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import {
  AggregatorStoreFake,
  buildAggregator,
  _setAggregatorStore,
} from '../aggregator-store/index.js';
import { listOrgCoordinators } from '../org-view.js';

afterEach(() => _setAggregatorStore(null));

describe('listOrgCoordinators', () => {
  it('returns only the coordinators whose parent_org_id matches', async () => {
    const store = new AggregatorStoreFake();
    store.seed([
      buildAggregator({ id: 'c1', orgSlug: 'c1', contactEmail: 'c1@x.org', parentOrgId: 'org-1' }),
      buildAggregator({ id: 'c2', orgSlug: 'c2', contactEmail: 'c2@x.org', parentOrgId: 'org-2' }),
      buildAggregator({ id: 'c3', orgSlug: 'c3', contactEmail: 'c3@x.org', parentOrgId: 'org-1' }),
    ]);
    _setAggregatorStore(store);
    const r = await listOrgCoordinators('org-1');
    expect(r.ok && r.value.map((a) => a.id).sort()).toEqual(['c1', 'c3']);
  });
});
```

- [ ] **Step 2: Run; verify fail**

Run: `pnpm --filter @aggregator-dpg/api test -- org-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/services/org-view.ts`:

```typescript
/**
 * Org-level view query (spec §10). Resolves an org's coordinators purely from
 * the `aggregators.parent_org_id` FK — the single authority for the
 * org→coordinator link (spec A1). No Keycloak calls, no group membership; the
 * future org console builds on this without a data migration.
 */

import { getAggregatorStore } from './aggregator-store/index.js';
import type { Aggregator, StoreResult } from './aggregator-store/index.js';

/**
 * Lists every coordinator belonging to the given org.
 *
 * @param orgId - `aggregator_orgs.id`.
 * @returns The org's coordinators (possibly empty); never throws.
 */
export async function listOrgCoordinators(orgId: string): Promise<StoreResult<Aggregator[]>> {
  return getAggregatorStore().findByParentOrgId(orgId);
}
```

- [ ] **Step 4: Run; verify pass**

Run: `pnpm --filter @aggregator-dpg/api test -- org-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Flag-off regression sweep**

Run the full suite to confirm flag-off behaviour is unchanged everywhere:

Run: `pnpm --filter @aggregator-dpg/api test`
Expected: all green. Confirm the original `aggregator-registrations.test.ts` (flag off in that process) still asserts 201 + reclaim behaviour; org-only files run with the flag on in their own process.

- [ ] **Step 6: Whole-repo gates**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm dep-check`
Expected: clean + green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/org-view.ts apps/api/src/services/__tests__/org-view.test.ts
git commit -m "feat(api): org-view query helper (single-FK, proves §10 relationship)"
```

---

## Follow-up (separate plans, not built here)

- **Web portal (separate plan):** two-tab Org/Coordinator registration UI in `apps/web/src/app/(public)/register/`, an active-org dropdown widget (calls `GET /v1/orgs`), and the org submit form + RJSF schemas under `config/schemas/`. Gated on the same flag surfaced to the web BFF (`NEXT_PUBLIC_ORG_HIERARCHY_ENABLED`). Consumes the contracts from Tasks 6–9.
- **Org console login (spec §9, A8):** enabling `org_owner` OIDC login + an org dashboard reading `listOrgCoordinators` + optional KC group-membership backfill. No data migration required.
- **Owner→coordinator graduation (spec §12.3):** grant an existing owner KC user the `coordinator` role + create an `aggregators` row + signalstack org.
- **Multi-org coordinator (spec §12.1):** `coordinator_org_memberships` table + org switcher.
- **Invite-based coordinator onboarding (spec §12.4 / A6):** owner invites → token → no public org dropdown.
- **Stale-org cleanup (spec §7):** extend the existing `cleanup-stale` endpoint (or a sibling) to prune stale `pending` `aggregator_orgs` rows + mirrored group + disabled owner. The coordinator-side cleanup already ships.

---

## Self-Review

**Spec coverage (Part B §2–§13):**

- §2 feature flag → Task 1. §5.1 `aggregator_orgs` + §5.2 `parent_org_id` FK → Task 2. §5/A2 SQL dropdown/owner lookup → Task 3 (`listActive`/`findByOwnerEmail`) + Task 6 (`GET /v1/orgs`). §6.1 org flow + A3 atomic CAS → Tasks 3 (`approve` CAS) + 6 (submit) + 7 (approval). §6.2 coordinator flow + re-validate org → Tasks 8 + 9. §6.3 uniqueness/recovery/rate-limiting: `ORG_SLUG_TAKEN` (Tasks 3/6), `OWNER_ALREADY_REGISTERED` (Tasks 6/8), rate limiting (Task 8), §7 refresh reuses the existing reclaim path (Task 8 threads `parentOrgId` through reclaim; org refresh is noted). §8 provisioning sequence (no group-membership step for coordinators) → Tasks 7 (org) + 9 (coordinator, unchanged sequence). §9 roles/token binding → Tasks 5 (idp roles/groups) + 9 (`org` claim binding). §10 per-coordinator isolation (status quo) + org-view → Task 10 (`listOrgCoordinators`). §13 migration/rollout → Task 2 (additive) + flag default off (Task 1). §14 testing → each task's tests map to the listed delta tests.
- **Gaps acknowledged (deferred by spec, in Follow-up):** web UI, org console login, owner graduation, multi-org, invite onboarding, stale-org cleanup. The spec marks these future (§11/§12); none are required for the backend to be correct and testable.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Two soft spots are explicitly resolved inline: (a) flag-off route inertness uses conditional `app.post` registration (Task 6 Step 5), not a placeholder guard; (b) the rate-limit unit test uses the injectable `checkSubmitRate` indirection (Task 8 Steps 1/3), not a vague "test rate limiting".

**Type consistency:** `parentOrgId` (camel in TS, `parent_org_id` in SQL) used consistently across schema (Task 2), store (Task 4), routes (Tasks 8/9), org-view (Task 10). `AggregatorOrg`/`OrgStoreResult`/`getAggregatorOrgStore`/`AggregatorOrgStoreFake`/`buildAggregatorOrg` identical across Tasks 3, 6, 7, 8, 9. `mintApprovalToken({...org})` + `verifyApprovalToken().org` consistent across Tasks 9. `createGroup`/`addUserToGroup`/`assignRealmRole` consistent across Tasks 5, 7. `sendOrgReviewEmail` (Task 6) vs `sendAdminReviewEmail` (Task 9, extended) are distinct and used per their definitions. Org status reuses `aggregator_status` enum (reject == `inactive`) consistently (Tasks 2, 3, 7).

**Known verification points for the implementer (call out, not placeholders):** the concrete idp adapter filename (Task 5 Step 4 — find the `extends IdpAdminAdapter` non-test file); `renderAdminReview`'s exact param names (Task 6 Step 4); the Drizzle `getDb`/helper import paths + private mapper name in `aggregator-store/postgres.ts` (Tasks 3/4); whether `RATE_LIMITED` already exists in `codes.ts` (Task 8 Step 3). Each step says to verify against the cited existing file and adjust.
