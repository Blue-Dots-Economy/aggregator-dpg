# QR Links Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator command that creates one live two-option registration link per sheet row on a coordinator's behalf, plus a local script that turns the resulting CSV into QR PNGs.

**Architecture:**

- The create step of `POST /v1/links/create` moves into a shared service that both the route and the command call.
- The command (`tools/qr-links*.ts`) follows the org loader's pattern: stdin CSV in, check then apply, report CSV on stdout, logs to stderr.
- A local script (`scripts/qr-images.ts`) renders the PNGs on the operator's laptop.

**Tech Stack:** Fastify, Drizzle, Vitest, papaparse (already in `apps/api`), `qrcode` (dev dependency only).

**Spec:** `docs/superpowers/specs/2026-11-20-qr-links-loader-design.md`

**Branch:** `feat/1119-qr-links` (`hotfix/up-speedrun` with the #1122 stack merged in). Its PR goes into `hotfix/up-speedrun`. Never push without Aniket's go-ahead.

## Global Constraints

- The command runs only as `node dist/tools/qr-links.js check|apply --links - --operator <name>`. It takes stdin only (`--links` must be `-`).
- Exit codes: 0 ok, 1 refused or failed, 2 usage. Unknown flags give 2.
- The entry sets `LOG_DESTINATION=stderr` unconditionally before config loads. stdout carries only the report CSV.
- Every external call goes through the timeout from config: reuse `BULK_UPLOAD_CMD_CALL_TIMEOUT_MS`, or add `QR_LINKS_CMD_CALL_TIMEOUT_MS` with the same bounds.
- `created_by` is the coordinator's `users.id`. The operator appears only in logs and the report, and goes through `provisionedBy(operator)` validation.
- The mode is the instance's two-option key (`voice_or_form`). Check it against `registration_modes` and `AGGREGATOR_ONBOARDING_ENABLED`; never hardcode it into behaviour.
- Logs carry ids, codes and counts only, never emails.
- Report columns, in order: `line,coordinator_email,profile_type,voice_bot,slug,url,outcome,error_code`. Outcomes are `created`, `already_loaded`, `failed` and `not_run`. Neutralise spreadsheet formulas, as the org-loader report does.
- `qrcode` options: `{ errorCorrectionLevel: 'M', margin: 1, width: 512 }`, the same as `RegistrationLinksSection.tsx`.
- Conventional Commits, no AI trailer, no `--no-verify`.

## Review Focus

1. **Coordinator email with different case or spaces from the stored contact.** It must still match. Test in Task 2.
2. **A rerun after a stop mid-file.** Earlier rows report `already_loaded` with their existing URL, and no duplicate links are created. Test in Task 3.
3. **A `link_name` already used by another coordinator.** Slugs are unique per user, so it is allowed; the same name twice for one coordinator is a duplicate-row problem. Test in Task 2.
4. **An instance with `voice_bots: []`.** Links still create, and `voice_bot` is blank in the report. Test in Task 3.
5. **Report or input with formula-like cells** (`=cmd`). The report neutralises them. Test in Task 3.

---

### Task 1: Shared link-create service

**Files:**

- Create: `apps/api/src/services/registration-links/create.ts`
- Modify: `apps/api/src/routes/registration-links.ts`. Move the create handler body (about lines 236–360) and the helpers `checkVoiceBotChoice`, `generateSlug`, `randomSuffix`, `SLUG_RETRIES` and `buildPublicUrl` into the service. The route keeps auth and maps results to the same HTTP errors.
- Test: `apps/api/src/services/registration-links/__tests__/create.test.ts`. The existing route tests must pass unchanged.

**Interfaces:**

- Produces:
  - `interface CreateLinkInput { userId: string; orgSlug: string; servedDomains: readonly string[]; domain: string; registrationMode?: string; voiceBotKey?: string | null; slug?: string; context?: Record<string, unknown>; status: 'draft' | 'live'; expiresAt?: Date | null; createdBy: string; log: FastifyBaseLogger }`
  - `createRegistrationLink(input): Promise<CreateLinkResult>`, where `CreateLinkResult` is `{ ok: true; value: { link: RegistrationLink; publicUrl: string | null } } | { ok: false; error: { code; detail?; fields?; cause? } }`. The error codes are the ones the route answers today.
  - `buildPublicUrl(orgSlug: string, slug: string): string`, exported.
- Follow the result and error shape of `services/registration/org-create.ts`, and reuse `errors/unwrap.ts` `unwrapOrThrow` in the route.

- [ ] **Step 1:** Write service tests (fakes for the store and network config):
  - live link with the default voice bot stores the resolved key;
  - an unserved domain is refused;
  - an undeclared mode is refused;
  - a slug collision retries with a suffix;
  - `publicUrl` is null for a draft.
- [ ] **Step 2:** Run `cd apps/api && pnpm exec vitest run src/services/registration-links/__tests__/create.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement by moving the code. The route calls the service.
- [ ] **Step 4:** Rerun, then the route tests (`pnpm exec vitest run src/routes/registration-links`), typecheck and `spec:dump` (no `openapi.json` drift). Expected: PASS.
- [ ] **Step 5:** Commit `refactor(api): move link creation out of the links route`.

### Task 2: Read and check the links sheet

**Files:**

- Create: `apps/api/src/tools/qr-links-input.ts` and `apps/api/src/tools/qr-links-plan.ts`
- Test: `apps/api/src/tools/__tests__/qr-links-input.test.ts` and `qr-links-plan.test.ts`

**Interfaces:**

- Consumes: the CSV rules of `org-loader-input.ts` (BOM strip, `,` delimiter, line numbers kept, `MALFORMED_ROW`). Reuse its internal parse helper if it can be exported cleanly; otherwise mirror it.
- Produces:
  - `interface LinkRow { line: number; coordinatorEmail: string; profileType: string; voiceBot: string; linkName: string; expiresOn: string }`. Strings are trimmed; the email is lowercased; empty means absent.
  - `parseLinksCsv(text: string): { rows: LinkRow[]; problems: InputProblem[] }`. `MISSING_COLUMN` applies to `coordinator_email` and `profile_type`; `UNKNOWN_COLUMN` applies to any other header outside the five.
  - `QR_PLAN_PROBLEM` constants: `UNKNOWN_COORDINATOR`, `COORDINATOR_NOT_ACTIVE`, `NO_SIGNALS_ORG`, `DOMAIN_NOT_SERVED`, `UNKNOWN_VOICE_BOT`, `VOICE_BOT_NOT_FOR_DOMAIN`, `VOICE_BOT_REQUIRED`, `INVALID_LINK_NAME`, `INVALID_EXPIRY`, `EXPIRY_IN_PAST`, `DUPLICATE_ROW`, `MODE_NOT_ENABLED`.
  - `interface PlannedLink { row: LinkRow; userId: string; orgSlug: string; domain: string; voiceBotKey: string | null; slug: string | undefined; expiresAt: Date | null; existing: { slug: string; url: string } | null }`
  - `buildLinksPlan(input: { rows: LinkRow[]; inputProblems: InputProblem[]; now?: Date }): Promise<{ links: PlannedLink[]; problems: InputProblem[] }>`
- Rules:
  - Coordinators are looked up by email (`userStore.findByContactEmail`).
  - `link_name` uses the route's slug regex.
  - `expires_on` is `YYYY-MM-DD`, read as end of day in UTC and required to be in the future.
  - A duplicate row is the same coordinator, profile type and `link_name`.
  - `existing` is a live link of the two-option mode for that coordinator and domain, with the same slug when `link_name` is given (via the links store `list`).

- [ ] **Step 1:** Tests:
  - BOM / CRLF / blank lines;
  - a missing required column;
  - an unknown column;
  - every plan problem code;
  - Review Focus 1 (`" Raj@X.org "` matches `raj@x.org`);
  - Review Focus 3 (the same name for two coordinators is OK; twice for one is `DUPLICATE_ROW`);
  - an existing live link makes `existing` set.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): read and check the QR links sheet`.

### Task 3: Apply, report and the command

**Files:**

- Create: `apps/api/src/tools/qr-links-apply.ts`, `apps/api/src/tools/qr-links-command.ts` and `apps/api/src/tools/qr-links.ts` (the entry: sets `LOG_DESTINATION`, then dynamic-imports the command, like `org-loader.ts`)
- Test: `apps/api/src/tools/__tests__/qr-links-apply.test.ts` and `qr-links-command.test.ts`

**Interfaces:**

- Consumes: `buildLinksPlan`, `PlannedLink` (Task 2); `createRegistrationLink`, `buildPublicUrl` (Task 1); `provisionedBy`.
- Produces:
  - `applyLinksPlan(plan, opts: { operator: string; log }): Promise<{ rows: LinkReportRow[]; failed: boolean }>`
    - `existing` gives `already_loaded` with the existing URL;
    - otherwise it calls `createRegistrationLink` with `{ status: 'live', registrationMode: <two-option key>, createdBy: userId }`;
    - it stops at the first failure, and the rest are `not_run`.
  - `LinkReportRow` holds the report columns from Global Constraints.
  - The command `main(argv, io)` mirrors `org-loader-command.ts`:
    - flag parsing with unknown flags giving 2;
    - stdin read with a TTY refused;
    - `check` prints problems as `<line> <code> <field>` to stderr and exits 1 on any problem;
    - `apply` writes the report CSV to stdout;
    - timeouts on DB and store calls;
    - `initRbac` is not needed;
    - DB is closed in `finally`.

- [ ] **Step 1:** Tests:
  - apply creates live links with the two-option mode and `created_by` set to the coordinator;
  - Review Focus 2: a rerun gives `already_loaded` with the URL and the store's create is not called again;
  - Review Focus 4: no bots gives a blank `voice_bot`;
  - a failure on the second row leaves the rest `not_run` with exit 1;
  - Review Focus 5: formula cells are neutralised;
  - the command: usage errors give 2, `--links seekers.csv` gives 2, stdout is pure CSV;
  - an entry test that the log destination is forced to stderr.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then typecheck, lint and `pnpm --filter @aggregator-dpg/api build && ls apps/api/dist/tools/qr-links.js`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): QR links command`.

### Task 4: Local QR image script, runbook and verification

**Files:**

- Modify: `apps/api/package.json` (devDependencies: `qrcode` and `@types/qrcode` at the web app's versions) and `pnpm-lock.yaml`
- Create: `apps/api/scripts/qr-images.ts` and `docs/qr-links-runbook.md`
- Test: `apps/api/scripts/__tests__/qr-images.test.ts` (or wherever `apps/api/scripts` tests are collected; if none are, put the pure helpers in `apps/api/src/tools/qr-images-lib.ts` with its test, and have the script import them)

**Interfaces:**

- Produces:
  - `qrFileName(row: { coordinatorEmail; profileType; slug }): string`. It returns `<local part>-<profile_type>-<slug>.png`, lowercase, characters outside `[a-z0-9-]` replaced with `-`.
  - `renderQrImages(csvText: string, outDir: string): Promise<{ written: number; skipped: number }>`. It writes rows with outcome `created` or `already_loaded`, with the options from Global Constraints.
  - The CLI is `--in <file> --out <dir>`. It refuses an existing non-empty `--out` unless `--force` is given.

- [ ] **Step 1:** Tests:
  - filename sanitising;
  - only `created` and `already_loaded` rows are written;
  - a PNG is written (check the signature bytes `89 50 4E 47`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the script and helpers. Write the runbook, covering:
  - the sheet template (columns);
  - `kubectl exec -i <pod> -c api -- node dist/tools/qr-links.js check --links - --operator <name> < links.csv`, then `apply … > links-report.csv`;
  - the local PNG step;
  - handing the files to product;
  - deleting local files;
  - the rerun rules;
  - the message and exit-code table;
  - the prerequisite: #1122 config with voice bots, and coordinators loaded and active.
- [ ] **Step 4:** Run the whole-branch checks: `pnpm -w lint`, `pnpm -w typecheck`, `pnpm dep-check`, `pnpm --filter @aggregator-dpg/api test`, `pnpm --filter @aggregator-dpg/web test` (the route refactor must not affect web), and `spec:dump` with no drift. Expected: all green.
- [ ] **Step 5:** Commit `feat(api): local QR image script and QR links runbook`.
