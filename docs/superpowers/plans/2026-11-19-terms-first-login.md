# Terms at Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At login, an owner or coordinator with no valid acceptance of the current terms version must accept the terms before using the portal. The acceptance is recorded with `source = 'first-login'`.

**Architecture:**

- The API gets two routes:
  - `GET /v1/user/consent/status`, backed by a read service over `consent_record`;
  - `POST /v1/user/consent`, which writes through the consent ledger.
- The web login callback checks the status once and stores `termsStatus` on the session.
- Both protected layouts send an `outstanding` session to `/accept-terms`, which shows `ConsentGate`.
- `callApi` refuses proxied API calls while terms are outstanding.

**Tech Stack:** Fastify, Drizzle/Postgres, `@aggregator-dpg/consent-ledger`, Next.js 15 App Router (Server Components, Route Handlers), next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-terms-first-login-design.md`

**Branches (two-PR stack, Aniket):**

- Tasks 1–3: `feat/1120-terms-first-login-api`, cut from the current `feat/1120-terms-first-login` (which holds the spec commit). Its PR goes into `feat/1118-org-structure-loader` until #1126 merges, then into `hotfix/up-speedrun`.
- Tasks 4–7: `feat/1120-terms-first-login-web`, on top of the API branch.
- Never push, and never PR into `feature`.

## Global Constraints

- **Source written:** `source = 'first-login'`.
- **Sources that count as accepted:** `('registration', 'registration-backfill', 'first-login')`, AND `valid_till IS NOT NULL AND valid_till > now()`, AND `terms_version` and `privacy_version` equal the current ones. Bulk-upload attestation rows never count.
- **Versions:** coordinators use `loadConsentConfig(network, brand).audiences.aggregator.documents.{terms,privacy}.current_version`; owners use `audiences.org`.
- **`validTill`** = now + `MAX_CONSENT_VALIDITY_MS` (`services/registration-consent.ts`).
- **Owners:** one subject per active owned org from `Actor.orgs` where `relation = 'owner'`, skipping `orgType === 'network_facilitator'` and `isDefault`.
- **API errors:**
  - stale versions → 409 `CONSENT_VERSION_CHANGED`;
  - web proxy block → 403 `TERMS_REQUIRED`.
- **Session field:** `termsStatus: 'ok' | 'outstanding' | 'unknown'`, optional, in the Zod `SessionDataSchema`. When absent, treat it as `'unknown'`.
- **`callApi` allow-list while outstanding:** `/v1/user/consent/status`, `/v1/user/consent`, `/v1/user/read/me`, `/v1/support/config`, `/v1/support`.
- **Logs:** ids, counts and codes only; no emails, phones or names.
- **Commits:** Conventional Commits, no AI trailer, no `--no-verify`.
- **Regenerate** `openapi.json` and `policy/rbac/edge/routes.json` when routes change (`pnpm --filter @aggregator-dpg/api spec:dump` and `routes:dump`) and commit them with the API task.

## Review Focus

1. **Owner of several orgs who accepted for one org earlier.** Status lists only the other orgs. Accepting writes rows for those only. Test in Task 1 and Task 2.
2. **Sessions that existed before this deploy** (no `termsStatus`). The first page load re-checks and stores the result; nobody is logged out. Test in Task 5.
3. **`returnTo` pointing off-site or at `/accept-terms` itself.** Fall back to the landing page; no loop. Test in Task 6.
4. **The terms text changes between page load and accept.** The page gets 409, reloads and shows the new text; no row is written. Test in Task 2 and Task 6.
5. **The API is down during the login status check.** The coordinator lands normally with `unknown`, and the next page re-checks. Test in Task 4.

---

### Task 1: Consent status read service and `GET /v1/user/consent/status`

**Files:**

- Create: `apps/api/src/services/consent-status.ts`
- Modify: `apps/api/src/routes/v1-user.ts` (register inside `registerV1UserRoutes`, next to `/v1/user/read/me`)
- Modify: `openapi.json`, `policy/rbac/edge/routes.json` (regenerated)
- Test: `apps/api/src/services/__tests__/consent-status.integration.test.ts` (Postgres, following `apps/api/src/db/__tests__/cleanup.integration.test.ts`); `apps/api/src/routes/v1-user-consent.test.ts` (route, with `ActorResolverFake` and a status-service fake)

**Interfaces:**

- Produces:
  - `type ConsentAudience = 'aggregator' | 'org'`
  - `interface ConsentSubjectRef { subjectType: 'user' | 'organisation'; subjectId: string }`
  - `interface ConsentStatus { outstanding: boolean; audience: ConsentAudience; termsVersion: number; privacyVersion: number; outstandingOrgIds: string[] }`. `outstandingOrgIds` is empty for coordinators.
  - `consentSubjectsOf(actor: Actor): { audience: ConsentAudience; subjects: ConsentSubjectRef[] }`, which is pure.
  - `getConsentStatus(actor: Actor): Promise<Result<ConsentStatus, BaseError>>`
  - `ACCEPTED_CONSENT_SOURCES = ['registration', 'registration-backfill', 'first-login'] as const`, exported; Task 3 reuses it.
- Route response, snake_case on the wire: `{ outstanding, audience, terms_version, privacy_version, org_ids }`.
- Route config: `rbac: { access: 'signed_in' }`, caller via `requireActor(req, { allowCoordinator: true })`.

- [ ] **Step 1: Write failing tests**
  - **Unit, `consentSubjectsOf`:**
    - a coordinator → audience `aggregator`, one `user` subject;
    - an admin owning root, Default and two aggregator orgs → audience `org`, two `organisation` subjects;
    - an admin owning only root → zero subjects.
  - **Integration, `getConsentStatus` on Postgres:**
    - a coordinator with a `registration` row at the current versions and future `valid_till` → `outstanding: false`;
    - the same row at `terms_version` minus 1 → `true`;
    - an expired `valid_till` → `true`;
    - only a `bulk_upload:x:v1` row (NULL `valid_till`) at the current versions → `true`;
    - only a `first-login` row → `false`;
    - an owner of orgs A and B with a row for A only → `outstanding: true`, `outstandingOrgIds: [B]`.
  - **Route:** 200 with the snake_case body; 401 without a token.
- [ ] **Step 2:** Run `cd apps/api && pnpm exec vitest run src/routes/v1-user-consent.test.ts`, then the integration file. Expected: FAIL.
- [ ] **Step 3: Implement.** Use one Drizzle query over `consent_record` filtered by subject ids, versions, sources and validity, grouped by subject.
- [ ] **Step 4:** Rerun both; then `spec:dump`, `routes:dump`, typecheck. Expected: PASS, and the regenerated files change only for the new route.
- [ ] **Step 5:** Commit `feat(api): read whether the caller accepted the current terms`.

### Task 2: `POST /v1/user/consent`

**Files:**

- Modify: `apps/api/src/routes/v1-user.ts`
- Create: `apps/api/src/services/consent-accept.ts`
- Modify: `openapi.json`, `policy/rbac/edge/routes.json`
- Test: `apps/api/src/services/__tests__/consent-accept.integration.test.ts`; extend `apps/api/src/routes/v1-user-consent.test.ts`

**Interfaces:**

- Consumes: `getConsentStatus` and `ConsentStatus` (Task 1); `getConsentLedger()` (`services/consent-ledger/index.ts`) with `withExecutor`; `MAX_CONSENT_VALIDITY_MS`; `resolveActiveNetwork()`.
- Produces:
  - `acceptCurrentTerms(actor: Actor, shown: { termsVersion: number; privacyVersion: number }, now?: Date): Promise<Result<{ recorded: number }, BaseError>>`. It returns a `DomainError` with code `CONSENT_VERSION_CHANGED` when `shown` differs from current.
  - Route body `{ terms_version: int ≥ 1, privacy_version: int ≥ 1 }` → 200 `{ recorded }`, or 409 `CONSENT_VERSION_CHANGED`. Config as in Task 1.

- [ ] **Step 1: Write failing tests:**
  - **Coordinator:** one row, `subject_type 'user'`, `source 'first-login'`, `valid_till` = now + `MAX_CONSENT_VALIDITY_MS`. Status afterwards is `outstanding: false`.
  - **Owner of A and B** with A already accepted: one row, for B.
  - **Owner with two outstanding orgs, second ledger write failing** (subclass the ledger fake, or use a Postgres trigger in the integration test): zero rows (all or nothing).
  - **Stale versions:** 409, zero rows.
  - **Second POST:** `recorded: 0`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Open one DB transaction and call `getConsentLedger().withExecutor(tx).recordRegistrationConsent({ subjectType, subjectId, network, brand, termsVersion, privacyVersion, validTill, source: 'first-login' })` for each outstanding subject. Log the operation, status, count, `user_id` and `org_ids`.
- [ ] **Step 4:** Rerun; regenerate the spec and routes; typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): record terms accepted at login`.

### Task 3: Profile shows first-login acceptances; API docs; runbook

**Files:**

- Modify: `apps/api/src/services/user-store/postgres.ts:62`. Build `REGISTRATION_CONSENT_SOURCES` from `ACCEPTED_CONSENT_SOURCES` (Task 1), so there is one list.
- Modify: `apps/api/CLAUDE.md`: one line on the two routes and the accepted-sources rule.
- Modify: `docs/org-structure-loader-runbook.md`:
  - "Deploy #1120 before telling anyone to log in";
  - a read-only "who has accepted at first login" query over `consent_record.source = 'first-login'` joined to provisioned `users` and `organisations`.
- Test: the existing user-store Postgres test for the profile consent view (find it with `grep -rn REGISTRATION_CONSENT_SOURCES apps/api/src`). Add a case where a `first-login` row is shown.

- [ ] **Step 1:** Add the failing test.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the source change and write the docs.
- [ ] **Step 4:** Run `cd apps/api && pnpm exec vitest run` on the touched test files, plus `pnpm --filter @aggregator-dpg/api typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): show terms accepted at login on the profile`. Then create the web branch: `git checkout -b feat/1120-terms-first-login-web`.

### Task 4: Session field, status helper and login callback

**Files:**

- Modify: `apps/web/src/lib/session/interface.ts` (`SessionDataSchema`): `termsStatus: z.enum(['ok','outstanding','unknown']).optional().catch(undefined)`.
- Create: `apps/web/src/lib/terms-status.server.ts`
- Modify: `apps/web/src/app/api/auth/callback/route.ts` (after `settleInvitedLogin`, `:106`)
- Test: `apps/web/src/__tests__/lib/terms-status.test.ts`; extend the existing callback route test (find it with `grep -rln "auth/callback" apps/web/src/__tests__`)

**Interfaces:**

- Produces:
  - `type TermsStatus = 'ok' | 'outstanding' | 'unknown'`
  - `interface TermsCheck { status: TermsStatus; audience?: 'aggregator' | 'org'; termsVersion?: number; privacyVersion?: number }`
  - `fetchTermsStatus(accessToken: string): Promise<TermsCheck>`. It does a direct `fetch` to `${API_BASE_URL}/v1/user/consent/status` with a bearer token and `AbortSignal.timeout(TERMS_STATUS_TIMEOUT_MS)`, like `lib/invite-activation.ts`. `TERMS_STATUS_TIMEOUT_MS = 5_000`, with TSDoc saying why. Any non-200 or error gives `{ status: 'unknown' }` and a warn log. It never throws.
  - `ACCEPT_TERMS_PATH = '/accept-terms'`
- **Callback:** sets `sessionData.termsStatus` from `fetchTermsStatus(tokens.accessToken).status`. When `outstanding`, it redirects to `/accept-terms?returnTo=<landingPath(...)>` instead of the landing page.

- [ ] **Step 1: Write failing tests:**
  - **`fetchTermsStatus`:** 200 outstanding → `outstanding`; 200 not outstanding → `ok`; 500 → `unknown`; a network error → `unknown`; a timeout (fake timers) → `unknown`.
  - **Callback:**
    - outstanding → 302 to `/accept-terms?returnTo=%2Fdashboard` for a coordinator, or `%2Fconsole` for an owner, with the session stored as `outstanding`;
    - `ok` → 302 to the landing page;
    - `unknown` (API down) → 302 to the landing page with the session `unknown` (Review Focus 5).
- [ ] **Step 2:** Run `pnpm --filter @aggregator-dpg/web exec vitest run <files>`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun; typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): check terms status at login`.

### Task 5: Layout guards and the `callApi` block

**Files:**

- Create: `apps/web/src/lib/terms-guard.server.ts`
- Modify: `apps/web/src/app/(protected)/layout.tsx` (after the coordinator check)
- Modify: `apps/web/src/app/(console)/console/layout.tsx` (after its session checks)
- Modify: `apps/web/src/lib/upstream-client.ts` (`callApi`)
- Test: `apps/web/src/__tests__/lib/terms-guard.test.ts`; `apps/web/src/__tests__/lib/upstream-client.test.ts` (extend if it exists)

**Interfaces:**

- Consumes: `fetchTermsStatus`, `ACCEPT_TERMS_PATH` (Task 4); the session store's update function (find it in `lib/session/`).
- Produces:
  - `ensureTermsAccepted(path: string): Promise<void>`
    - `outstanding` → `redirect('/accept-terms?returnTo=' + encodeURIComponent(path))`;
    - `unknown` or absent → calls `fetchTermsStatus(session.accessToken)`, stores the result, and redirects only on `outstanding`;
    - `ok` → returns.
  - `TERMS_ALLOWED_API_PATHS`: the allow-list from Global Constraints.
- **`callApi`:** when `session.termsStatus === 'outstanding'` and the path is not in the allow-list, it returns a 403 JSON `Response` `{ code: 'TERMS_REQUIRED' }` without calling upstream.

- [ ] **Step 1: Write failing tests:**
  - **`ensureTermsAccepted`:**
    - `outstanding` redirects with the encoded path;
    - `ok` returns;
    - absent with status `ok` stores `ok` and returns (Review Focus 2);
    - absent with status `outstanding` stores it and redirects;
    - absent with status `unknown` returns (fail-open).
  - **`callApi`:** an outstanding session calling `/v1/dashboard/items` → 403 `TERMS_REQUIRED` with no fetch; calling `/v1/user/consent` → passes through; an `ok` session → passes through.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Call `await ensureTermsAccepted(path)` in both layouts. The console layout gets its path from the `x-pathname` header, as `(protected)/layout.tsx` does.
- [ ] **Step 4:** Rerun; typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): block the portal and API proxy until terms are accepted`.

### Task 6: `/accept-terms` page and BFF route

**Files:**

- Create: `apps/web/src/lib/safe-return.ts`. Move `isSafeReturnTo` here from `app/api/auth/login/route.ts` and import it back there.
- Create: `apps/web/src/app/accept-terms/page.tsx` (Server Component) and `apps/web/src/app/accept-terms/AcceptTermsView.tsx` (`'use client'`)
- Create: `apps/web/src/app/api/consent/route.ts`
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json`. Add an `accept_terms` block: `title`, `intro`, `agree_label`, `log_out`, `changed`, `failed`. Reuse the `consent.load_failed_detail` style.
- Test: `apps/web/src/__tests__/app/accept-terms.test.tsx`; `apps/web/src/__tests__/app/api/consent-route.test.ts`; `apps/web/src/__tests__/lib/safe-return.test.ts`

**Interfaces:**

- Consumes: `fetchTermsStatus` (Task 4); `loadConsentContent()` (`app/(public)/register/register-server.ts`); `ConsentGate`; `rejectCrossSite` (`lib/same-origin.ts`); `callApi`.
- **Page (server):**
  - no session → redirect to `/api/auth/login?returnTo=/accept-terms`;
  - `returnTo` = `isSafeReturnTo(searchParams.returnTo)`, falling back to `/dashboard` or `/console` by token type; never `/accept-terms` itself (Review Focus 3);
  - fresh `fetchTermsStatus`:
    - `ok` → store `ok` and redirect to `returnTo` (no loop);
    - `unknown` → redirect to `returnTo`;
    - `outstanding` → render `AcceptTermsView` with the audience's docs and `{ termsVersion, privacyVersion }`.
- **View (client):**
  - `ConsentGate` open, no `onCancel`, `agreeLabel` from i18n;
  - on accept, POST `/api/consent` with `{ terms_version, privacy_version }`:
    - 200 → `window.location.assign(returnTo)`;
    - 409 → show `changed` and `router.refresh()`;
    - other → show `failed`;
  - a plain link to `/api/auth/logout`.
- **BFF `POST /api/consent`:** `rejectCrossSite`; validate the body with Zod; `callApi('/v1/user/consent', { method: 'POST', body })`; on 200 set `session.termsStatus = 'ok'`; pass the upstream status and body through.

- [ ] **Step 1: Write failing tests:**
  - **`safe-return`:** absolute URLs, `//host`, `/accept-terms`, and empty all give the fallback.
  - **Page:** outstanding renders the gate with the coordinator docs for a coordinator and the org docs for an owner; `ok` redirects and stores `ok`.
  - **View:** accept posts the versions; 409 shows `changed` and refreshes (Review Focus 4).
  - **BFF route:**
    - cross-site → 403;
    - 200 sets the session `ok`;
    - 409 passes through and leaves the session `outstanding`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Make any `ConsentGate` change additive, for example a prop for page layout.
- [ ] **Step 4:** Rerun; typecheck; lint. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): accept-terms page and consent route`.

### Task 7: Stack verification

- [ ] **Step 1:** On the API branch, run `pnpm -w lint && pnpm -w typecheck && pnpm --filter @aggregator-dpg/api test && pnpm dep-check`, plus the two new integration files. Expected: green.
- [ ] **Step 2:** On the web branch, run the same plus `pnpm --filter @aggregator-dpg/web test`. Expected: green.
- [ ] **Step 3:** Report. Pushing, the stacked PRs and CI wait for Aniket's go-ahead.
