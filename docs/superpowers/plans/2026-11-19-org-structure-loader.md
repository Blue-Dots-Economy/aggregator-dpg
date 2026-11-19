# Org Structure Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator command in the API image that loads orgs, owners and coordinators from two CSV files and leaves them approved: no emails, no terms acceptance, safe to rerun.

**Architecture:**
- The create steps of the two invite-accept routes move into shared services under `apps/api/src/services/registration/`, with no change in route behaviour.
- A new tool, `apps/api/src/tools/org-loader*.ts`, parses the CSVs, builds and checks a plan, then applies it through those services and the existing `approveOrg` / `approveCoordinator`.
- Accounts it creates carry `created_by = provisioned:<operator>`. The consent rule and the upgrade check exempt those accounts until they accept the terms.

**Tech Stack:** TypeScript, Fastify API package, Drizzle/Postgres stores, Keycloak admin adapter, Vitest with the existing fakes (`UserStoreFake`, `OrganisationStoreFake`, `IdpAdminFake`, `ConsentLedgerFake`, `FakeMailer`, `_setSignalStackWriter`), papaparse.

**Spec:** `docs/superpowers/specs/2026-11-19-org-structure-loader-design.md`

**Branch:** `feat/1118-org-structure-loader`, PR into `hotfix/up-speedrun` (never into `feature`). Run CI by hand: `gh workflow run ci.yml --ref feat/1118-org-structure-loader`.

## Global Constraints

- Marker: `created_by` / `updated_by` = `provisioned:<operator>`, from one exported helper. No other place spells the prefix.
- The loader writes no `consent_record` row and sends no mail. The invite-accept routes still always write consent.
- Approval `decidedBy` = `provisioned:<operator>`.
- Commands: `node dist/tools/org-loader.js check|apply|template`. Exit codes: 0 ok, 1 refused or failed, 2 usage.
- `apply` runs every check first and refuses to start on any problem. It stops at the first failed row.
- Logs: counts, ids and error codes only. No names, emails or phones. Those appear only in the report file.
- Repo rules (`.claude/rules/`): `Result` across service boundaries, TSDoc on exports, named constants, no `any` or `as` casts, fakes over `vi.mock`.
- Commit subject: Conventional Commits, no AI trailer (repo `CLAUDE.md`).
- `profile_types` in the CSV are separated by `;`.

## Review Focus

1. **CSV from Excel with a UTF-8 BOM, CRLF line ends, trailing spaces or blank lines.** Expect the same result as a clean file. Test in Task 6.
2. **Phones written as `9876543210`, `+91 98765 43210` or `09876543210`.** Expect normalisation before duplicate checks, so the same person is not reported twice. Test in Task 7.
3. **An org row that names a parent defined later in the same file.** Expect it to load after its parent. Test in Task 7.
4. **`apply` rerun after a stop between org approval and the coordinators.** Expect orgs reported `already_loaded` and coordinators created. Test in Task 8.
5. **A CSV row matching a real invitee's pending registration.** Expect a check error, never an approval. Test in Task 7.

---

### Task 1: Provisioned marker and store support for consent-less create

**Files:**
- Create: `apps/api/src/services/provisioned.ts`
- Modify: `apps/api/src/services/organisation-store/interface.ts` (`CreateOrgInput`, about line 96)
- Modify: `apps/api/src/services/organisation-store/postgres.ts` (`create`, lines 116-184)
- Modify: `apps/api/src/services/organisation-store/memory.ts`
- Modify: `apps/api/src/services/user-store/interface.ts` (`CreateCoordinatorInput`, about line 117)
- Modify: `apps/api/src/services/user-store/postgres.ts`, `memory.ts`
- Test: `apps/api/src/services/__tests__/provisioned.test.ts`, `apps/api/src/services/organisation-store/__tests__/memory-provisioned.test.ts`, `apps/api/src/services/user-store/__tests__/memory-provisioned.test.ts`

**Interfaces:**
- Produces:
  - `PROVISIONED_PREFIX = 'provisioned:'`
  - `provisionedBy(operator: string): string`. Throws `ValidationError` on an empty operator or one with whitespace or `:`.
  - `isProvisioned(createdBy: string | null | undefined): boolean`
- Produces on `CreateOrgInput`:
  - `createdBy?: string` (default `'self'`)
  - `recordConsent?: RecordConsentHook`. The doc says it is absent only when `isProvisioned(createdBy)`.
- Produces on `CreateCoordinatorInput`: `consent?: ConsentRecord` and `recordConsent?: RecordConsentHook`, under the same rule.
- New store error `{ code: 'CONSENT_REQUIRED'; message: string }` on both stores. It is returned when `recordConsent` is absent and the account is not provisioned.

- [ ] **Step 1: Write failing tests**
  - `provisionedBy('ops-anil') === 'provisioned:ops-anil'`; `isProvisioned('provisioned:x') === true`; `isProvisioned('self') === false`; `provisionedBy('a b')` throws.
  - Memory org store:
    - `create({ ...base, createdBy: 'provisioned:ops', recordConsent: undefined })` → ok, and the row's `createdBy` is `'provisioned:ops'`;
    - the same input with `createdBy: 'self'` → `CONSENT_REQUIRED`.
  - Memory user store: the same pair for coordinators.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- provisioned`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Postgres org `create`: write `createdBy` / `updatedBy` from the input instead of the hard-coded `'self'`. Call `recordConsent` only when given.
  - Both stores: return `CONSENT_REQUIRED` before opening a transaction when the hook is absent and the account is not provisioned.
  - Update the "Required, so no … is created without a consent record" docs to state the provisioned exception.
- [ ] **Step 4:** Run the tests again, plus `pnpm --filter @aggregator-dpg/api test -- organisation-store user-store`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): let operator-provisioned accounts be created without a consent row`.

### Task 2: Move org creation into a shared service

**Files:**
- Create: `apps/api/src/services/registration/org-create.ts`
- Modify: `apps/api/src/routes/aggregator-orgs.ts`. Move out `OrgInviteAcceptBodySchema`'s non-invite fields as `OrgFormSchema`, plus `buildOrgProfile`, `findOwnerContactClash`, `discardHalfCreatedOrg`, `checkOrgSubmission`, `createOrgRecord`, `throwOrgCreateError` and `provisionOrgLogin`.
- Test: `apps/api/src/services/registration/__tests__/org-create.test.ts`. Keep `apps/api/src/routes/aggregator-orgs.test.ts` and `invite-accept.test.ts` unchanged and green.

**Interfaces:**
- Produces:
  - `OrgFormSchema`: zod; the accept body without `invite`. `consent` is optional here; the route schema still requires it.
  - `type OrgCreateErrorCode`: the route's existing `ErrorCode`s: `SCHEMA_VALIDATION`, `INVALID_PHONE`, `ORG_NAME_TAKEN`, `ORG_SLUG_TAKEN`, `USER_EXISTS`, `PHONE_EXISTS`, `NAME_INVALID_CHARACTERS`, `CONSENT_WRITE_FAILED`, `IDP_UNAVAILABLE`, `DB_UNAVAILABLE`, plus the tree-refusal codes `throwTreeRefusal` maps.
  - `interface OrgCreateError { code: OrgCreateErrorCode; fields?: Record<string, unknown>; cause?: Error }`
  - `checkOrgForm(body: OrgForm): Promise<Result<{ schemaValues: Record<string, unknown>; phoneE164: string }, OrgCreateError>>`
  - `findOwnerContactClash(ownerEmail: string, phoneE164: string): Promise<Result<'email' | 'phone' | null, OrgCreateError>>`
  - `createOrgWithOwner(input: { form: OrgForm; schemaValues; phoneE164; parentId?: string; createdBy: string; recordConsent?: RecordConsentHook; existingOwnerKcSub?: string; log: FastifyBaseLogger }): Promise<Result<{ org: Organisation; slug: string; groupId: string; ownerKcSub: string }, OrgCreateError>>`
- Behaviour of `createOrgWithOwner`:
  - Creates the org row, then the Keycloak group, then the owner user.
  - With `existingOwnerKcSub`, it skips owner creation and stamps that sub.
  - Then stamps both on the org. On failure it rolls back exactly as today.
- The route keeps invite claiming, the rate limit and `assertOwnerFree`. It maps `!result.ok` to `throw httpError(error.code, { fields, cause })`.

- [ ] **Step 1: Write failing tests** with the fakes:
  - `createOrgWithOwner` with no `recordConsent` and `createdBy: 'provisioned:ops'` → ok. `ConsentLedgerFake` has no rows. The `IdpAdminFake` owner has `decision_made: 'invited'`.
  - With `existingOwnerKcSub: 'kc-1'` → no `createUser` call, and `org.ownerKcSub === 'kc-1'`.
  - `IdpAdminFake` `createUser` failing `USER_EXISTS` → error `USER_EXISTS`, and the org row and group are removed.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- org-create`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the code. The route calls the service and is otherwise unchanged.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test -- org-create aggregator-orgs invite-accept`. Expected: PASS, with route tests unchanged.
- [ ] **Step 5:** Commit `refactor(api): move org creation out of the invite-accept route`.

### Task 3: Move coordinator creation into a shared service

**Files:**
- Create: `apps/api/src/services/registration/coordinator-create.ts`
- Modify: `apps/api/src/routes/aggregator-registrations.ts`. Move out `checkCoordinatorSubmission` without the rate limit, plus `assertContactFree`, `assertNotInKeycloak`, `createCoordinatorRow`, `createCoordinatorLogin`, `createAggregatorWithSlug`, `mapStoreCreateError`, `buildAggregatorProfile` and `ownLocations`.
- Modify: `apps/api/src/services/registration-validator.ts`
- Test: `apps/api/src/services/registration/__tests__/coordinator-create.test.ts`. Keep `aggregator-registrations.test.ts` and `invite-accept.test.ts` green.

**Interfaces:**
- Produces:
  - `getRegistrationValidator(opts?: { consentRequired?: boolean }): Promise<ValidateFunction>`. The default `true` is unchanged. `false` compiles a copy with `consent` removed from `required`, cached separately.
  - `type CoordinatorCreateErrorCode`: `SCHEMA_VALIDATION`, `INVALID_PHONE`, `USER_EXISTS`, `PHONE_EXISTS`, `CONFLICT`, `DUPLICATE_SLUG`, `NAME_INVALID_CHARACTERS`, `CONSENT_WRITE_FAILED`, `IDP_UNAVAILABLE`, `DB_UNAVAILABLE`.
  - `interface CoordinatorCreateError { code; fields?; cause? }`
  - `checkCoordinatorForm(body: RegistrationPayload, opts: { consentRequired: boolean }): Promise<Result<{ contact: BecknContact; phoneE164: string; consent: ConsentRecord | null; domains: string[] }, CoordinatorCreateError>>`
  - `assertContactFree(email: string, phoneE164: string): Promise<Result<void, CoordinatorCreateError>>`
  - `createCoordinatorWithLogin(input: { body: RegistrationPayload; contact; domains; orgId: string; createdBy: string; consent: ConsentRecord | null; recordConsent?: RecordConsentHook; inviteId: string | null; locations: BecknLocation[]; log }): Promise<Result<{ userId: string; orgSlug: string; kcUserId: string }, CoordinatorCreateError>>`

- [ ] **Step 1: Write failing tests:**
  - `checkCoordinatorForm` with no `consent` and `consentRequired: false` → ok with `consent: null`. With `consentRequired: true` → `SCHEMA_VALIDATION`.
  - `createCoordinatorWithLogin` with `createdBy: 'provisioned:ops'` and no hook → ok. There is no ledger row. The Keycloak user has `aggregator_id = userId`, `aggregator_type = domains` and `decision_made: 'invited'`. The row's `createdBy` is `'provisioned:ops'`.
  - Keycloak `createUser` failing → the user row is deleted, and the result is `USER_EXISTS` or `IDP_UNAVAILABLE`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- coordinator-create`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the code. The route keeps invite claiming, the rate limit, `assertNotOrgOwner` and `assertNoOrgDetails`, and maps errors to `httpError` as today.
- [ ] **Step 4:** Run `pnpm --filter @aggregator-dpg/api test -- coordinator-create aggregator-registrations invite-accept registration-validator`. Expected: PASS.
- [ ] **Step 5:** Commit `refactor(api): move coordinator creation out of the invite-accept route`.

### Task 4: Consent check accepts first-login acceptances and skips provisioned accounts

**Files:**
- Modify: `scripts/sql/cleanup-verify.sql` (V1, lines 8-15)
- Modify: root `CLAUDE.md` (the "fail-closed: no subject is provisioned without a consent record" sentence) and `apps/api/CLAUDE.md` (the consent-ledger rollback contract)
- Test: `apps/api/src/tools/__tests__/instance-upgrade-check.integration.test.ts`

**Interfaces:**
- Produces: V1 counts coordinators with no `consent_record` where `source IN ('registration','registration-backfill','first-login') AND valid_till IS NOT NULL`, excluding `u.created_by LIKE 'provisioned:%'`.

- [ ] **Step 1: Write the failing integration case** in the existing file:
  - Seed one coordinator with `created_by = 'provisioned:ops'` and no consent → V1 `n = 0`.
  - Seed one with `created_by = 'self'` and no consent → V1 `n = 1`.
  - Seed one with only a `source = 'first-login'` row → not counted.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api exec vitest run src/tools/__tests__/instance-upgrade-check.integration.test.ts` (needs Docker). Expected: FAIL.
- [ ] **Step 3:** Edit V1 as specified. Update both `CLAUDE.md` sentences to state the rule: "every account has an acceptance, or was provisioned by an operator (`created_by = provisioned:<operator>`) and has not accepted yet".
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): count first-login acceptances and skip provisioned accounts in the consent check`.

### Task 5: Hold the route-level guarantee

**Files:**
- Test: `apps/api/src/routes/invite-accept.test.ts` (add cases)

- [ ] **Step 1:** Add tests:
  - An org accept body without `consent` → 400 `SCHEMA_VALIDATION`, as before.
  - Both accept routes still write exactly one ledger row (`ConsentLedgerFake`) and `created_by = 'self'`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- invite-accept`. Expected: PASS. These pin existing behaviour; if one fails, Task 2 or 3 changed the routes and must be fixed there.
- [ ] **Step 3:** Commit `test(api): pin that invite accepts still record consent`.

### Task 6: Parse the loader CSVs

**Files:**
- Modify: `apps/api/package.json` (add `papaparse` and `@types/papaparse` at the worker's versions); `pnpm-lock.yaml`
- Create: `apps/api/src/tools/org-loader-input.ts`
- Test: `apps/api/src/tools/__tests__/org-loader-input.test.ts`

**Interfaces:**
- Produces:
  - `interface OrgRow { line: number; name: string; parent: string | null; owner: { name: string; email: string; phone: string }; extra: Record<string, string>; address: Partial<Record<AddressPart, string>> }`
  - `interface CoordinatorRow { line: number; org: string; name: string; email: string; phone: string; profileTypes: string[]; extra: Record<string, string> }`
  - `interface InputProblem { file: 'orgs' | 'coordinators'; line: number; code: string; field?: string }`
  - `parseOrgsCsv(text: string): { rows: OrgRow[]; problems: InputProblem[] }`
  - `parseCoordinatorsCsv(text: string): { rows: CoordinatorRow[]; problems: InputProblem[] }`
- Columns, as in the spec:
  - Orgs: `name`, `parent`, `owner_name`, `owner_phone`, `owner_email`, `address_streetAddress|addressLocality|addressDistrict|addressRegion|postalCode|addressCountry`. Any other column goes into `extra`.
  - Coordinators: `org`, `name`, `phone`, `email`, `profile_types`. Any other column goes into `extra`.
- Parsing rules:
  - Header names are trimmed and lowercased; the address suffixes keep their case.
  - Cells are trimmed. Empty cells are absent. `line` counts from 2 (after the header).

- [ ] **Step 1: Write failing tests:**
  - A clean file.
  - The same file with a BOM, CRLF and a trailing blank line gives identical rows.
  - A missing required column gives problem `MISSING_COLUMN`.
  - An empty required cell gives `REQUIRED` with `field`.
  - `profile_types` of `seeker; provider` gives `['seeker','provider']`.
  - An unknown column lands in `extra`.
  - Email is lowercased.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- org-loader-input`. Expected: FAIL.
- [ ] **Step 3:** Implement with `Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })` after stripping a leading `﻿`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): parse org-loader CSVs`.

### Task 7: Build and check the load plan

**Files:**
- Create: `apps/api/src/tools/org-loader-plan.ts`
- Test: `apps/api/src/tools/__tests__/org-loader-plan.test.ts`

**Interfaces:**
- Consumes:
  - Task 6 rows;
  - `checkOrgForm` and `findOwnerContactClash` from Task 2;
  - `checkCoordinatorForm` and `assertContactFree` from Task 3;
  - `isProvisioned` from Task 1;
  - `getOrganisationStore()`, `getUserStore()`, `getIdpAdmin()`, `getNetworkConfig()`;
  - `treeRules`;
  - `config.ADMIN_EMAILS`, the `DEFAULT_ORG_OWNER_EMAIL` reader.
- Produces:
  - `type PlanAction = 'create' | 'resume' | 'already_loaded'`
  - `interface PlannedOrg { row: OrgRow; action: PlanAction; existingOrgId?: string; parentRef: { kind: 'root' } | { kind: 'existing'; orgId: string } | { kind: 'planned'; name: string }; existingOwnerKcSub?: string; form: OrgForm; schemaValues: Record<string, unknown>; phoneE164: string }`
  - `interface PlannedCoordinator { row: CoordinatorRow; action: PlanAction; existingUserId?: string; orgRef: { kind: 'existing'; orgId: string } | { kind: 'planned'; name: string }; body: RegistrationPayload; contact: BecknContact; domains: string[] }`
  - `interface LoadPlan { orgs: PlannedOrg[]; coordinators: PlannedCoordinator[]; problems: InputProblem[] }`. `orgs` is ordered parents first.
  - `buildLoadPlan(input: { orgs: OrgRow[]; coordinators: CoordinatorRow[] }): Promise<LoadPlan>`
- Problem codes:
  - **In the files:** `DUPLICATE_ORG_NAME` (case-insensitive); `OWNER_CONTACT_MISMATCH` (same owner email with a different phone, after `normalisePhone`, or a different name); `OWNER_IS_COORDINATOR`; `DUPLICATE_COORDINATOR` (email or normalised phone).
  - **Parents:** `UNKNOWN_PARENT`, `PARENT_CYCLE`, `COORDINATOR_IN_ROOT`, `UNKNOWN_ORG`, `TREE_LIMIT` (depth, children or total, after the whole file).
  - **Against existing data:**
    - `ORG_EXISTS_OTHER_OWNER`;
    - `OWNER_HAS_PENDING_ORG` (from `listOwnedBy`);
    - `OWNER_RESERVED` (the first `ADMIN_EMAILS` or `DEFAULT_ORG_OWNER_EMAIL`);
    - `CONTACT_TAKEN` (email or phone held by another person);
    - `NOT_PROVISIONED_PENDING` (a matching pending row whose `createdBy` is not provisioned);
    - `COORDINATOR_EXISTS_ELSEWHERE`;
    - `SCHEMA_VALIDATION` and `INVALID_PHONE` with `field`.
- How existing rows map to actions:
  - an existing active provisioned row → `already_loaded`;
  - a pending provisioned row → `resume`.
- Forms:
  - The org `form` is `{ display_name: row.name, owner, address, ...extra }`.
  - The coordinator `body` is `{ name: <org display name>, type: profileTypes, contact: { name, email, phone }, ...extra }`.

- [ ] **Step 1: Write failing tests**, one per problem code above. Also:
  - A three-level tree given child-first comes back parent-first.
  - The same owner on two rows with `9876543210` and `+91 98765 43210` → one owner, no problem.
  - A pending row with `createdBy = 'self'` matching a CSV coordinator → `NOT_PROVISIONED_PENDING`.
  - A provisioned active org → `already_loaded`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- org-loader-plan`. Expected: FAIL.
- [ ] **Step 3:** Implement. The tree order is a topological sort by `parent` name. A cycle reports `PARENT_CYCLE` on every row in it.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): plan and check an org-loader run`.

### Task 8: Apply the plan

**Files:**
- Create: `apps/api/src/tools/org-loader-apply.ts`
- Test: `apps/api/src/tools/__tests__/org-loader-apply.test.ts`

**Interfaces:**
- Consumes:
  - `LoadPlan` (Task 7);
  - `createOrgWithOwner` (Task 2);
  - `createCoordinatorWithLogin` (Task 3);
  - `provisionedBy` (Task 1);
  - `approveOrg`, `approveCoordinator` (`services/decisions/*`);
  - `getIdpAdmin().setUserDecision`;
  - `syncTokenRoles`.
- Produces:
  - `type RowOutcome = 'created' | 'resumed' | 'already_loaded' | 'failed' | 'not_run'`
  - `interface ReportRow { kind: 'org' | 'coordinator'; line: number; name: string; email: string; outcome: RowOutcome; orgId?: string; userId?: string; signalsOrgId?: string; errorCode?: string; rolesSync?: TokenRolesOutcome }`
  - `applyLoadPlan(plan: LoadPlan, opts: { operator: string; log: FastifyBaseLogger }): Promise<{ rows: ReportRow[]; failed: boolean }>`
- Order and behaviour:
  1. **Orgs, in plan order.** Resolve `planned` parents to the ids created earlier in the run.
     - `create`: `createOrgWithOwner` with no hook, `createdBy = provisionedBy(operator)` and `existingOwnerKcSub`. Then `approveOrg({ orgId, decidedBy })`. Then, only when `ownerAccess.status === 'granted'`, `setUserDecision(ownerKcSub, 'approved')`.
     - `resume`: the same steps from approval on.
     - A half-created provisioned row (no `ownerKcSub` or `kcGroupId`) is deleted with the group or user linked by id, then created again.
  2. **Coordinators.** `createCoordinatorWithLogin` with `consent: null`, no hook, `inviteId: null` and `createdBy` as above. Then `approveCoordinator({ aggregatorId, decidedBy })`. A provisioned pending row with no Keycloak user is deleted and created again.
  3. **Roles.** After each approval, `await syncTokenRoles(id, 'provisioned')` and record the outcome. It never fails the row.
- On the first `failed` row, stop. Every row after it is `not_run`.

- [ ] **Step 1: Write failing tests** with the fakes (`_setOrganisationStore`, `_setUserStore`, `_setIdpAdmin`, `_setConsentLedger`, `_setMailer`, `_setSignalStackWriter`, `_setNetworkConfig`):
  - A two-level tree with one owner on two orgs and two coordinators → all `created`. Orgs and coordinators are `active`. The Signals fake has two orgs. `ConsentLedgerFake` has 0 rows. `FakeMailer` sent 0.
  - Rerun on the same fakes → every row `already_loaded` (via a fresh `buildLoadPlan`).
  - A failure injected on the second coordinator's `createUser` → that row is `failed`, the rest `not_run`. A rerun after clearing the fault → the earlier rows `already_loaded`, that row `created`.
  - Stopping after org approval, then rerunning → orgs `already_loaded`, coordinators `created` (Review Focus 4).
  - A partial owner grant → `decision_made` stays `invited`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- org-loader-apply`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): apply an org-loader plan through the approve services`.

### Task 9: The command, the report, the template and the runbook

**Files:**
- Create: `apps/api/src/tools/org-loader.ts`, following the `instance-upgrade.ts` entry pattern (`main(argv)`, `_main` export, the run guard).
- Create: `docs/org-structure-loader-runbook.md`
- Test: `apps/api/src/tools/__tests__/org-loader.test.ts`; `apps/api/src/tools/__tests__/org-loader.integration.test.ts` (Postgres via the existing Testcontainers setup, plus the Keycloak and Signals fakes)

**Interfaces:**
- Consumes: Tasks 6-8; `initRbac()`; `closeDb()`; `getNetworkConfig()`.
- Produces:
  - `main(argv: string[]): Promise<number>`
  - `template --out <dir>` writes `orgs.csv` and `coordinators.csv` headers from the instance's `org-registration.v1.json` and `registration.v1.json`: the fixed columns plus every schema property that isn't a fixed key or `consent`.
  - `check --orgs <file> --coordinators <file>`: either file may be absent, but not both. It prints problems as `file:line code field`.
  - `apply` takes the same files plus `--operator <name>` (required) and `--report <file>` (default `org-loader-report-<ISO time>.csv`). It initialises RBAC, then runs plan, check and apply.

- [ ] **Step 1: Write failing tests:**
  - **Unit:**
    - no subcommand → exit 2;
    - `apply` without `--operator` → 2;
    - problems → 1, nothing applied;
    - success → 0, with a report CSV holding every `ReportRow` field in the interface order;
    - `template` columns for the blue_dot config include `owner_email` and exclude `consent`.
  - **Integration:** `apply` on a fresh migrated database → V1 from `cleanup-verify.sql` returns 0; every created row has `created_by LIKE 'provisioned:%'`; rerun exit 0 with all `already_loaded`.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api test -- org-loader`, then the integration file with `vitest run`. Expected: FAIL.
- [ ] **Step 3: Implement the command.** Then write the runbook, covering:
  - sheet template per instance;
  - `kubectl cp` into the API pod;
  - `check`, then `apply`;
  - reading the report;
  - fixing failures and rerunning;
  - deleting the files;
  - "nobody is told to log in until the terms screen (#1120) is live";
  - "Returning to the main release cycle", copied from the spec's section of the same name, including the read-only count query: `SELECT count(*) FROM users u WHERE u.created_by LIKE 'provisioned:%' AND NOT EXISTS (SELECT 1 FROM consent_record c WHERE c.user_id = u.id AND c.source = 'first-login')`.
- [ ] **Step 4:** Rerun both. Expected: PASS. Then run `pnpm --filter @aggregator-dpg/api build && ls apps/api/dist/tools/org-loader.js`.
- [ ] **Step 5:** Commit `feat(api): org-loader command, report and runbook`.

### Task 10: Whole-branch verification

- [ ] **Step 1:** Run `pnpm -w lint && pnpm -w typecheck && pnpm --filter @aggregator-dpg/api test --coverage && pnpm dep-check`. Expected: all pass, with coverage ≥ 70% on the new files.
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/api spec:dump && git diff --exit-code openapi.json`. Expected: no diff, since no route shape changed.
- [ ] **Step 3:** Report the results. Pushing and the PR into `hotfix/up-speedrun` wait for Aniket's go-ahead.
