# Owner Onboarding (#1121) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An aggregator org owner adds themselves as a coordinator in their own org (same contact, same Keycloak login) and switches the web between the console and the coordinator shell to onboard seekers and providers.

**Architecture:**

- **Data.** `user_identities` allows at most one account per type per login.
- **API.** It accepts an `X-Acting-Account` header from an owner token only when the header names that login's own active coordinator account. It then builds the normal coordinator context from the DB row.
- **Token and edge.** The roles claim of a shared login carries `acting:<id>:<role>` entries. The OPA edge uses them only for a matching header.
- **Web.** The BFF keeps the acting account in the server-side session and adds the header in `callApi`.

**Tech Stack:** Fastify + Zod + Drizzle (Postgres), Keycloak admin API, OPA/Rego behind Envoy ext_authz (gRPC), Next.js 15 App Router BFF with Redis sessions, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-owner-onboarding-design.md` (read it first; section refs below are to it).

## Global Constraints

- Work on stacked branches cut from `develop` (`a8cf36ff`). The bottom PR's base is `develop`, and so is its target. After the stack merges, sync `develop` back into `feature` (merge commit). That is a user-confirmed exception for this ticket.
  - `feat/1121-owner-onboarding-api`, holding Tasks 1–7 plus the spec and this plan;
  - `feat/1121-owner-onboarding-web`, holding Tasks 8–10.
- Use `gh stack` per `.claude/rules/pull-requests.md`. There is no infra PR: Envoy's gRPC ext_authz already forwards every request header to OPA (`infra/envoy/envoy.yaml:95-103`), so `x-acting-account` needs no Envoy change.
- Header name: `x-acting-account`. It is exported once as `ACTING_ACCOUNT_HEADER` from `@aggregator-dpg/shared-primitives/user-org`; the API and web import it.
- Claim prefix: `acting:`. It is exported once as `ACTING_ROLE_PREFIX` from `@aggregator-dpg/rbac`, with `actingRoleEntry(accountId, roleKey): string` → `acting:<accountId>:<roleKey>`. The Rego policy uses the same literal, and an edge test pins it.
- Migrations come only from `pnpm --filter @aggregator-dpg/api db:generate` (custom SQL via `drizzle-kit generate --custom`). Never hand-edit a generated file.
- Never write `aggregator_id`, `decision_made`, `signalstack_org_id`, or coordinator-only `roles` on a Keycloak user that is linked to an admin account, and never enable, disable or revoke sessions for such a user from a coordinator path.
- Self-add is for owners of an active `aggregator` org that is not `slug = 'default'`, and is refused for any admin who owns the root.
- Repo rules apply: Result types and no throwing across services, TSDoc, pino structured logs with no PII, no `as` casts, and Conventional Commit subjects with **no AI attribution** (repo CLAUDE.md).
- Regenerate `openapi.json` (`pnpm --filter @aggregator-dpg/api spec:dump`) and `policy/rbac/edge/routes.json` (`routes:dump`) in the API PR. CI fails if they're stale.

## Review Focus

1. **The coordinator row is deactivated while the owner is still in acting mode.** The next API call must fail with `403` (not show stale data), and the web must drop back to the console with a message, not loop. _Pinned in Task 4 and Task 9._
2. **The token has no `acting:` entries yet (first request right after self-add, or the sync was deferred).** The edge gives `403`. The BFF switch refreshes the token first and, if the entries are still missing after the refresh, reports "not ready, try again" instead of entering acting mode. _Pinned in Task 8._
3. **The owner opens a console URL directly while in acting mode.** The console must never send the header; leaving acting mode is automatic. _Pinned in Task 9._
4. **A plain coordinator sends `x-acting-account` with its own id or another id.** Its own id behaves as today; any other id gives `403` at the API, and the edge also refuses it because there are no tagged entries. _Pinned in Task 4 and Task 7._
5. **Self-add when the owner's email or phone already belongs to another person's coordinator, or the owner already has a coordinator account in another org.** The answer is `409` with a code the dialog shows, and nothing is created in Signals or Keycloak. _Pinned in Task 5._

---

### Task 1: `user_identities.user_type` and a type-aware identity store

**Files:**

- Modify: `packages/db-schema/src/schema.ts:331-349`
- Create (generated): three migrations under `apps/api/drizzle/migrations/`
- Modify: `apps/api/src/db/account-writes.ts` (`linkIdentity` ~89, `subjectOf` ~127, a new `userOfSubject`), `apps/api/src/services/identity-store/{interface,postgres,memory}.ts`
- Test: `apps/api/src/services/identity-store/memory.test.ts` (create if absent), `apps/api/src/db/account-writes.integration.test.ts` (create if absent)

**Interfaces:**

- Produces:
  - `IdentityStoreBase.userOf(provider: string, subject: string, userType?: 'admin' | 'coordinator'): Promise<IdentityStoreResult<string | null>>`. Without `userType` it returns the admin account if one exists, else the coordinator.
  - `IdentityStoreBase.accountsOf(provider: string, subject: string): Promise<IdentityStoreResult<{ admin: string | null; coordinator: string | null }>>`.
  - `link(...)` now writes `user_type` from the `users` row; `DUPLICATE` only when the same subject is already linked to another account **of the same type**.

- [ ] **Step 1: Write failing tests** (memory store and integration):
  - `link(coordId, 'keycloak', 'sub-1')` after `link(adminId, 'keycloak', 'sub-1')` gives `linked`;
  - a second coordinator on `sub-1` gives `DUPLICATE`;
  - `userOf('keycloak','sub-1')` gives `adminId`;
  - `userOf('keycloak','sub-1','coordinator')` gives `coordId`;
  - `accountsOf` gives `{admin: adminId, coordinator: coordId}`;
  - a coordinator-only subject's `userOf` gives `coordId`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- identity-store`. Expect FAIL.
- [ ] **Step 3: Migration, in three generated steps.**
  - (a) Add `userType: userTypeEnum('user_type')` (nullable) to the table and run `db:generate`.
  - (b) Run `pnpm --filter @aggregator-dpg/api exec drizzle-kit generate --custom --name user_identities_user_type_backfill` and write `UPDATE user_identities ui SET user_type = u.user_type FROM users u WHERE u.id = ui.user_id AND ui.user_type IS NULL;`. That is schema-coupled DML (apps/api/CLAUDE.md, migrations rule).
  - (c) Make the column `.notNull()`; replace `user_identities_provider_subject_unique` with `unique('user_identities_provider_subject_type_unique').on(table.provider, table.subject, table.userType)`; add the composite FK `(user_id, user_type) → users (id, user_type)` with a `unique('users_id_type_unique').on(table.id, table.userType)` on `users`; run `db:generate`.
  - Update the comment above the table: "one account per type per external login".
- [ ] **Step 4: Implement** the store and `account-writes` changes. The admin preference is `ORDER BY user_type = 'admin' DESC LIMIT 1`.
- [ ] **Step 5: Audit every `userOf` caller.** Run `grep -rn "userOf(" apps/api/src`. Each one either keeps the default (admin first) or passes the type it needs. Note each decision in the commit body. At minimum, the actor resolver (Task 4) and `organisation-root.ts:~513` keep the default.
- [ ] **Step 6:** Run `pnpm --filter @aggregator-dpg/api test` and `pnpm --filter @aggregator-dpg/api test -- account-writes.integration` with the Postgres test DB. Expect PASS; existing tests stay green.
- [ ] **Step 7:** Commit `feat(api): one login may link one account per type (#1121)`.

### Task 2: Boot reconcile and the H-5 docs

**Files:**

- Modify: `apps/api/src/services/organisation-root.ts` (header comment 14-15; `ownerConflict` 155-172; refusal ~535)
- Modify: `docs/rbac/phase-5-rbac-handoff.md:30`, `docs/plans/user-org-target-model.md:59`
- Test: `apps/api/src/services/__tests__/organisation-root.test.ts:~642`

**Interfaces:** Consumes Task 1's type-aware `link`. `ownerConflict` returns `'owner_owns_other_org' | null`.

- [ ] **Step 1:** Change the test at ~642 to expect that the root owner whose email also has a coordinator account **is applied**. The admin row is linked to the same subject, and the coordinator's identity row is untouched. Keep the `owner_owns_other_org` test.
- [ ] **Step 2:** Run it. Expect FAIL.
- [ ] **Step 3:** Remove the `owner_is_coordinator` branch and the `coordinator` column from the query; update the header comment and both docs to "at most one account per type per login".
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test -- organisation-root`. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): owners may also hold a coordinator account (#1121)`.

### Task 3: Shared constants and the acting-account check

**Files:**

- Modify: `packages/shared-primitives/src/user-org/*.ts` (export `ACTING_ACCOUNT_HEADER = 'x-acting-account'`; add `own_coordinator_account_id: z.guid().nullable().optional()` to `MeResponseSchema` ~194)
- Modify: `packages/rbac/src/index.ts` (or the file exporting `effectiveRoleKeys`): `ACTING_ROLE_PREFIX`, `actingRoleEntry`, `parseActingRoleEntry(entry: string): { accountId: string; roleKey: string } | null`
- Create: `apps/api/src/services/auth/acting.ts`
- Test: `apps/api/src/services/auth/acting.test.ts`, `packages/rbac/src/acting.test.ts`

**Interfaces:**

- Produces: `resolveActingAccount(subject: string, accountId: string): Promise<Result<Coordinator, ActingError>>`, where `ActingError = { code: 'NOT_LINKED' | 'NOT_SHARED_LOGIN' | 'INACTIVE' | 'UNAVAILABLE'; message: string }`.
- Checks, in order:
  1. `accountsOf(IDP_PROVIDER, subject).coordinator === accountId`, else `NOT_LINKED`;
  2. `.admin !== null`, else `NOT_SHARED_LOGIN`;
  3. `getUserStore().findById(accountId)` exists, its status is not deactivated, and its org is active, else `INACTIVE`.
- Store failures map to `UNAVAILABLE`.

- [ ] **Step 1: Write tests** with the memory identity, user and org stores (seed helpers from each `./testing`):
  - the happy path returns the row;
  - each of the three failures returns its code;
  - an admin id passed as `accountId` gives `NOT_LINKED`;
  - `actingRoleEntry('u1','coordinator') === 'acting:u1:coordinator'`, and the parse round-trips;
  - `parseActingRoleEntry('org_admin') === null`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test -- acting` and `pnpm --filter @aggregator-dpg/rbac test`. Expect PASS.
- [ ] **Step 5:** Commit `feat(api): resolve an owner's acting coordinator account (#1121)`.

### Task 4: Acting on coordinator routes and in the actor resolver

**Files:**

- Modify: `apps/api/src/services/auth/access-token.ts` (`requireApproved` ~190-215; a new `actingContext` helper next to `hydrateContext` ~158)
- Modify: `apps/api/src/services/auth/actor/interface.ts:51` (`ResolveActorInput.actingAccountId?: string`), `actor/store.ts:72-87`, `actor/require.ts:59-62`
- Modify: `apps/api/src/routes/v1-user.ts` `meOf` (fill `own_coordinator_account_id` for an admin actor from `accountsOf(...).coordinator`)
- Test: `apps/api/src/services/auth/access-token.acting.test.ts`, `apps/api/src/services/auth/actor/store.test.ts`, `apps/api/src/routes/onboarding.test.ts`, `bulk-uploads.test.ts`, `registration-links.registration-mode.test.ts`, `dashboard.test.ts` (one acting case each)

**Interfaces:**

- Consumes `resolveActingAccount` (Task 3) and `ACTING_ACCOUNT_HEADER`.
- `requireApproved(req)` keeps its signature. In the acting path, the `AuthContext` is built from the row:
  - `aggregatorId` = `row.id`;
  - `serves` = `row.serves`;
  - `decisionMade` = row status mapped (approved/active → `'approved'`, pending → `'pending'`, rejected → `'rejected'`);
  - `signalstackOrgId` = the row value.
    The token supplies only `userId` (sub), email, names, phone and azp.

- [ ] **Step 1: Write failing tests.**
  - **(a)** A token with no `aggregator_id` plus the header for a linked active coordinator: `requireApproved` is ok, the context comes from the row, and `backfillSignalstackOrgId` and `recordLoginIdentity` are **not** called (spy via the idp-admin fake: no `setAttributes`).
  - **(b)** The same with an unlinked id: `403` with code `ACTING_ACCOUNT_INVALID` (new in `errors/codes.ts`; also used for (d), a deactivated row and a malformed id).
  - **(c)** The row has no `signalstack_org_id`: `NOT_APPROVED`.
  - **(d)** A coordinator token whose header differs from its claim: `403`. Its header equal to the claim: today's behaviour.
  - **(e)** No claim and no header: `MISSING_AGGREGATOR_ID`.
  - **(f)** The resolver with `actingAccountId` returns the coordinator actor; without it, an owner with a coordinator account resolves to the admin.
  - **(g)** `GET /v1/onboarding/summary` acting as the owner's coordinator returns only that coordinator's counts, with a second coordinator in the same org seeded with data.
  - **(h)** `/v1/user/read/me` without the header returns `kind: 'admin'` and `own_coordinator_account_id`.
  - **(i)** `aggregator-profile` (`authenticate` only) with the header and no claim still gives `MISSING_AGGREGATOR_ID`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. Read the header once per request; a malformed id (not a guid) gives `403 ACTING_ACCOUNT_INVALID`. Log `operation: 'auth.acting'` with `status` and the error code only.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test`. Expect PASS, all existing suites green.
- [ ] **Step 5:** Commit `feat(api): accept an owner's acting coordinator account (#1121)`.

### Task 5: Self-add ("Add myself to My Team")

**Files:**

- Modify: `apps/api/src/services/decisions/coordinator.ts` (`loadCoordinatorAndUser` ~40-62; `approve` ~95-175)
- Create: `apps/api/src/services/registration/owner-self-add.ts`
- Modify: `apps/api/src/routes/v1-user.ts` (new route `POST /v1/user/self/add`, `config: { rbac: { capability: 'org.manage' } }` like `/v1/user/invite` at 522)
- Modify: the coordinator deactivate/remove path behind `POST /v1/user/metadata/update/:id` (skip Keycloak user writes when `accountsOf(subject).admin` is set)
- Modify: `packages/shared-primitives/src/user-org/*.ts` (`SelfAddRequestSchema = z.object({ org_id: z.guid(), serves: z.array(ProfileTypeSchema).min(1) })`, response `UserSchema`)
- Test: `apps/api/src/services/registration/owner-self-add.test.ts`, `apps/api/src/services/decisions/coordinator.shared-login.test.ts`, `apps/api/src/routes/v1-console.test.ts`

**Interfaces:**

- Produces: `ownerSelfAdd(actor: Actor, subject: string, input: SelfAddRequest, log): Promise<Result<Coordinator, SelfAddError>>`, where `SelfAddError` codes are `NOT_ORG_OWNER | ORG_NOT_ELIGIBLE | ALREADY_COORDINATOR | NO_PROFILE_TYPES | UNAVAILABLE`.
- The route maps them to `403` (owner and eligibility), `409` (`ALREADY_COORDINATOR`), `422` (no types) and `503`.
- Error codes are added to `apps/api/src/errors/codes.ts`.

- [ ] **Step 1: Write failing tests.**
  - The happy path:
    - creates a coordinator row on the owner's `contact_id` with `org_id` and `serves`;
    - links `(keycloak, sub, coordinator)`;
    - the Signals fake gets one `upsertAggregator` with `external_id` = the new id;
    - the row ends approved with `signalstack_org_id` set;
    - the idp-admin fake records **zero** calls to `enableUser`, `setUserDecision`, `setAttributes`, `disableUser` and `logout`.
  - Refusals:
    - the Default org gives `ORG_NOT_ELIGIBLE`;
    - a root owner gives `ORG_NOT_ELIGIBLE`;
    - an org the caller doesn't own gives `NOT_ORG_OWNER`;
    - a second self-add, in the same or another org, gives `ALREADY_COORDINATOR`;
    - an empty `serves` is refused (schema `422`).
  - A forced `approveFromPending` failure on a shared login makes **no** `restoreInvited` or `compensate` Keycloak call.
  - Deactivating the owner's coordinator account through `metadata/update` makes no Keycloak user call, and its live roles are revoked.
  - A deactivated self-account is reactivated by self-add instead of returning `ALREADY_COORDINATOR`.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3: Implement.**
  - `loadCoordinatorAndUser` finds the Keycloak user by `subjectOf(id)` first, and falls back to the `aggregator_id` attribute.
  - `approve()` computes `sharedLogin = accountsOf(subject).admin !== null` once and guards every Keycloak write and both compensations.
  - The self-add runs in one DB transaction for the row and the link, then calls `approveCoordinator` with `decidedBy` = the owner's admin id.
  - Audit-log `operation: 'user.self_add'`.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test`, then `spec:dump` and `routes:dump`. Expect PASS; regenerated files staged.
- [ ] **Step 5:** Commit `feat(api): let an org owner add themselves as a coordinator (#1121)`.

### Task 6: Roles claim for a shared login

**Files:**

- Modify: `apps/api/src/services/authz/token-roles.ts` (`run` ~74-133, `defaultTokenRolesDeps` ~108)
- Test: `apps/api/src/services/authz/token-roles.test.ts`

**Interfaces:**

- Consumes `accountsOf`, `actingRoleEntry` and `tokenRolesOf`.
- New behaviour of `syncTokenRoles(userId)`: when `userId` is on a shared login, it **re-targets to the admin account id**. It takes the lock on the admin id and writes `tokenRolesOf(adminActor) ∪ tokenRolesOf(coordActor).map(k => actingRoleEntry(coordId, k))`, sorted. An inactive coordinator contributes nothing.
- Add `TokenRolesDeps.accountsOf(userId: string)` → `{ admin: string | null; coordinator: string | null }` (via `subjectOf` then `accountsOf`) so the tests inject it.

- [ ] **Step 1: Write failing tests** with fake deps:
  - a sync of the coordinator id writes once, to the shared Keycloak user, with the admin roles plus `acting:<coordId>:coordinator`;
  - a sync of the admin id writes the same list;
  - after deactivating the coordinator, the list has no `acting:` entries;
  - a non-shared coordinator behaves as today;
  - the lock key is the admin id for both triggers.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test -- token-roles`. Expect PASS.
- [ ] **Step 5: Audit the readers of the `roles` claim.** Run `grep -rn "\.roles\b\|'roles'" apps/web/src apps/api/src --include='*.ts*'`. Make sure every reader ignores entries containing `:`. Add a test wherever a reader would otherwise treat `acting:…` as a role key.
- [ ] **Step 6:** Commit `feat(api): carry an owner's coordinator roles in the token, tagged (#1121)`.

### Task 7: Edge policy and docs

**Files:**

- Modify: `policy/rbac/edge.rego` (`roles` at 56-59 and its users: `permissions` 72-76, the `count(roles) == 0` check ~139)
- Modify: `policy/rbac/edge_test.rego` and the shared vectors used by the API's TS edge test (`grep -rln "edge" apps/api/src/services/authz/*.test.ts`)
- Modify: `docs/rbac/rbac-edge-enforcement.md` (Status line 7; §3.2 claim format; new "Acting account" subsection), `apps/api/CLAUDE.md` (a short acting-account note under auth)
- Commit the spec and this plan on this branch too (already on `feat/1121-owner-onboarding`; rebase them into the API branch)

**Interfaces:**

- `raw_roles` stays the parsed claim set.
- `acting_id := lower(object.get(http.headers, "x-acting-account", ""))`.
- `roles := {r | some e in raw_roles; not contains(e, ":"); r := e}` when `acting_id == ""`.
- Otherwise `roles := {k | some e in raw_roles; startswith(e, concat("", ["acting:", acting_id, ":"])); k := substring(e, count(acting_id) + 8, -1)}`. Here 8 = `count("acting:") + count(":")`; give it a named rule, not a bare number.

- [ ] **Step 1: Write failing Rego tests.**
  - An owner token `["org_admin","acting:A:coordinator"]`:
    - with no header: `GET /v1/bulk-uploads/:id/errors.csv` is denied (no `view_pii`), and `GET /v1/user/read/me` is allowed;
    - with header `A`: `errors.csv` is allowed and the console-only `org.manage` route is denied;
    - with header `B`: every capability route is denied.
  - A coordinator token `["coordinator"]` with header `X`: denied on capability routes.
  - A coordinator token with no header: unchanged.
- [ ] **Step 2:** Run `opa test policy/rbac -v`. Expect FAIL.
- [ ] **Step 3:** Implement and update the docs.
- [ ] **Step 4:** Run `opa check policy/rbac && opa test policy/rbac -v` and `pnpm --filter @aggregator-dpg/api test -- edge`. Expect PASS.
- [ ] **Step 5:** Commit `feat(rbac): edge applies acting-account roles only with a matching header (#1121)`.
- [ ] **Step 6: Open the API PR.**
  - Run `gh stack init --base develop feat/1121-owner-onboarding-api`, push, and `gh stack submit`. The PR body follows `.github/PULL_REQUEST_TEMPLATE.md` and includes In Plain Terms, "Part 1 of 2", and a release note on the boot re-link of owners who were refused for being coordinators.
  - **Ask the user before pushing.**
  - No infra change: the edge policy ships in the API image (edge-init copies it); the image must be built from the head of the whole stack (#1132), and `rbac.mode` must be log or enforce for the edge to apply.

### Task 8: Web session, `callApi` header and the BFF switch routes

**Files:**

- Modify: `apps/web/src/lib/session/interface.ts:27-47` (`actingAccountId: z.guid().optional()`)
- Modify: `apps/web/src/lib/upstream-client.ts:65-80`. It is the only BFF path that sends the user's token; `bff-service-proxy.ts`, `invite-read.server.ts` and `invite-activation.ts` use the service token and stay unchanged.
- Create: `apps/web/src/app/api/auth/acting/route.ts` (`POST`, `DELETE`)
- Test: `apps/web/src/lib/upstream-client.test.ts`, `apps/web/src/app/api/auth/acting/route.test.ts`

**Interfaces:**

- Consumes `ACTING_ACCOUNT_HEADER` and `MeResponse.own_coordinator_account_id`.
- `POST` body `{ accountId: string }` does the following:
  1. requires a session;
  2. reads `/me` without the header and requires `own_coordinator_account_id === accountId`, else `403`;
  3. force-refreshes the access token through the existing refresh helper in `lib/oidc`;
  4. checks the new token's `roles` contains an entry starting `acting:<accountId>:`, else `409 { code: 'ACTING_NOT_READY' }`;
  5. stores `actingAccountId`, clears `consoleActor`, and returns `{ redirect: '/onboarding' }`.
- `DELETE ?returnTo=` clears both and redirects to a same-origin `returnTo`, or `/console`.

- [ ] **Step 1: Write failing tests.**
  - `callApi` adds the header only when the session has `actingAccountId`.
  - `POST` with a mismatched id gives `403` and the session is unchanged.
  - `POST` when the refreshed token lacks the tagged entry gives `409 ACTING_NOT_READY`.
  - `POST` happy path: the session is set and the cache cleared.
  - `DELETE` clears the session and rejects an off-origin `returnTo`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/web test -- acting upstream-client`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expect PASS.
- [ ] **Step 5:** Commit `feat(web): keep an owner's acting account in the session (#1121)`.

### Task 9: Shell gates, Back to console, banner

**Files:**

- Modify: `apps/web/src/app/(protected)/layout.tsx:36-44`, `apps/web/src/app/(console)/console/layout.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx` (acting mode: "← Back to console" above OVERVIEW, which calls `DELETE /api/auth/acting`; "Account Details" links to `/console/profile`)
- Create: `apps/web/src/components/shell/ActingBanner.tsx` (on `/onboarding` only)
- Modify: `apps/web/src/lib/auth-context` (expose `acting: boolean`)
- Copy: the existing i18n message files used by the shell (add keys; English text from spec §5.4)
- Test: the layout tests next to each layout, `Sidebar.test.tsx`, `ActingBanner.test.tsx`

**Interfaces:**

- `(protected)` admits `tokenAggregatorId(token) || session.actingAccountId`. An acting session whose API calls return `403 ACTING_ACCOUNT_INVALID` is redirected to `DELETE /api/auth/acting?returnTo=/console&reason=acting_ended`.
- `(console)` redirects to `DELETE /api/auth/acting?returnTo=<path>` when `session.actingAccountId` is set.

- [ ] **Step 1: Write failing tests.**
  - An owner session with `actingAccountId` renders the coordinator shell, with "Back to console" and the banner.
  - Without it, the owner is redirected to `/console`, as today.
  - A console request with `actingAccountId` redirects to the clear route.
  - A deactivated acting account ends at `/console?reason=acting_ended` with a notice, not a loop.
  - A plain coordinator sees no "Back to console".
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/web test`. Expect PASS.
- [ ] **Step 5:** Commit `feat(web): switch between console and own onboarding (#1121)`.

### Task 10: Console entry points — sidebar item, "Add myself", "You" tag

**Files:**

- Modify: the console sidebar component used by `app/(console)/console/layout.tsx` (group "MY ONBOARDING" with "Onboard participants" when `me.own_coordinator_account_id`; the click calls `POST /api/auth/acting` and shows `ACTING_NOT_READY` as "Setting up your access — try again in a minute")
- Modify: `apps/web/src/app/(console)/console/coordinators/**` (My Team): an "＋ Add myself to My Team" button when `kind === 'admin' && !is_network_admin && !own_coordinator_account_id` and the current org is not the Default org; a dialog with a Seekers/Providers checkbox (at least one) and an org picker only when the owner owns more than one eligible org; it posts through a new BFF route `app/api/console/user/self-add/route.ts` to `POST /v1/user/self/add`, shows `409`/`403` codes inline, and on success refreshes the page
- Modify: the My Team row: a "You" tag when `row.id === me.own_coordinator_account_id`
- Test: component tests for the sidebar item, the button visibility matrix, the dialog validation and error codes, and the "You" tag; a route test for the BFF self-add

**Interfaces:** Consumes the `SelfAddRequestSchema` and error codes from Task 5, and the BFF `POST /api/auth/acting` from Task 8.

- [ ] **Step 1: Write failing tests.**
  - The button shows only for an eligible owner without an account, and is hidden for the network admin, on the Default org, and once the account exists.
  - The dialog refuses an empty profile-type selection.
  - A `409 ALREADY_COORDINATOR` is shown inline.
  - The sidebar item shows only with `own_coordinator_account_id`.
  - The "You" tag shows on the matching row only.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/web test`, `pnpm -w typecheck`, `pnpm -w lint` and `pnpm dep-check`. Expect all PASS.
- [ ] **Step 5:** Commit `feat(web): let owners add themselves and open their onboarding (#1121)`.
- [ ] **Step 6: Open the web PR.**
  - Run `gh stack add feat/1121-owner-onboarding-web` (or re-parent the branch), push, `gh stack submit`, then `gh workflow run ci.yml --ref feat/1121-owner-onboarding-web` and report the result.
  - **Ask the user before pushing.**

### After merge (not a code task)

- Ask the user, then sync `develop` into `feature` (a merge PR). Then open a merge PR into `hotfix/up-speedrun`, or cherry-pick the squash commits. Expect conflicts in the registration area (`coordinator-create.ts`); this work doesn't edit those checks.
- UAT check (ticket "Done when"):
  1. An owner adds themselves, opens "Onboard participants", creates a link, runs an upload, downloads the errors file and sees the counts.
  2. The console works as before.
  3. The decoded owner token has no `aggregator_id`, `decision_made` or `signalstack_org_id`.
