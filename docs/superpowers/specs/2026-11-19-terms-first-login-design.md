# Terms at login: design

**Issue:** #1120, part of the instance speed-run (bluedots-infra-deployments#146)
**Branch:** side branch `hotfix/up-speedrun` (never merged to `feature`; see `2026-11-19-org-structure-loader-design.md`, "Where the code lives")
**Date:** 2026-11-19
**Status:** approved 2026-11-19

## Why

The org loader (#1118) creates owners and coordinators already approved, but with no terms acceptance: nobody accepted anything on their behalf. Before any of them is told to log in, the portal must show them the terms and privacy notice and record their acceptance.

Aniket decided the rule is general, not loader-specific. **Anyone** (owner or coordinator) who has no acceptance of the **current** terms version sees the screen at login. Today that means only loaded accounts, since everyone else accepted at registration. When a terms version is raised in `consent.json` later, every owner and coordinator is asked again at their next login.

## Goals

- At login, an owner or coordinator with no valid acceptance of the current terms and privacy versions is sent to an accept-terms screen and cannot use the portal or console until they accept.
- The acceptance is recorded in the consent ledger like any other, with `source = 'first-login'`.
- People who already hold a valid acceptance of the current versions never see the screen.

## Non-goals

- Tracking who has logged in. That is a one-off read-only runbook query, not a product feature (Aniket).
- Emails or reminders.
- Re-checking during a session. A version raised mid-session applies from the next login.
- Participants (Signals users). This is the aggregator portal only.

## Anti-goals

- Locking everyone out when the API is down.
- A way round the screen by typing a URL.
- Recording an acceptance nobody gave, for example by writing it before the person clicks.

## Constraints

- **Where acceptance lives.** The consent ledger (`consent_record`, append-only):
  - coordinator acceptance is `subject_type = 'user'` on the coordinator's `users.id`;
  - owner acceptance is **per org**, `subject_type = 'organisation'` on each org.
- **Versions.** `loadConsentConfig(network, brand)` gives `audiences.aggregator.documents.{terms,privacy}.current_version` for coordinators and `audiences.org` for owners.
- **Writer.** `ConsentLedgerBase.recordRegistrationConsent` is the only writer. The ledger has no read method; the user store reads `consent_record` directly (`user-store/postgres.ts:~446-460`).
- **Validity.** `valid_till` is capped at `MAX_CONSENT_VALIDITY_MS` (five years, `services/registration-consent.ts`).
- **Login flow.** `apps/web/src/app/api/auth/callback/route.ts` runs token exchange, then `settleInvitedLogin` (`:106`), then creates the session and redirects to `landingPath` (`/dashboard` for a coordinator, `/console` for an owner).
- **Layouts.** `(protected)/layout.tsx` and `(console)/console/layout.tsx` run on every request.
- **Who is calling.** The API resolves the caller with `requireActor(req, { allowCoordinator: true })`, as `/v1/user/read/me` does (`routes/v1-user.ts:~383-392`, `rbac: { access: 'signed_in' }`). Every new route declares its RBAC access, and `policy/rbac/edge/routes.json` and `openapi.json` are regenerated.
- **Screen.** `ConsentGate` (`components/consent/ConsentGate.tsx`) is a blocking scroll-to-end gate that cannot be closed when no `onCancel` is given. `loadConsentContent()` (`app/(public)/register/register-server.ts:19`) loads the aggregator and org documents.
- Repo rules in `.claude/rules/`.
- **PRs:** a two-PR stack per `.claude/rules/pull-requests.md` (Aniket): PR 1 = API plus this design doc and the runbook note; PR 2 = web, on top.
- **Base:** stacked on `feat/1118-org-structure-loader` (PR #1126), which carries the V1 change, the loader and its runbook. Rebase onto `hotfix/up-speedrun` once #1126 merges (author's call).

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Check once at login; the session carries a mark; both protected layouts send a marked session to `/accept-terms`; accepting goes through a BFF route to the API and clears the mark. | One API call per login. Follows the invite-activation pattern in the same callback. |
| B | Check on every page load from both layouts, with no session mark. | Always current, but an extra API round trip on every portal and console page. |
| C | The API refuses every route with `TERMS_REQUIRED` until accepted. | Strongest, but touches every route and the RBAC edge. Too big. |

Also rejected: Keycloak's built-in terms required action. It records no version and writes nothing to the consent ledger.

Aniket picked A.

## Design

### API (`apps/api`)

**`GET /v1/user/consent/status`**, `rbac: { access: 'signed_in' }`, caller from `requireActor(req, { allowCoordinator: true })`.

- **Coordinator:** one subject, its `users.id`, against the `aggregator` audience versions.
- **Owner (admin):** one subject per active org it owns, against the `org` audience versions. The network facilitator root and the Default org are **skipped**: they are system orgs with config-defined owners that never register (author's call).
- A subject is **accepted** when a `consent_record` row exists for it with:
  - `terms_version = current` and `privacy_version = current`;
  - `valid_till IS NOT NULL AND valid_till > now()`;
  - `source IN ('registration', 'registration-backfill', 'first-login')`. These are the same sources the profile view and upgrade check V1 count. Bulk-upload attestation rows (`bulk_upload:…`, NULL `valid_till`) are **not** a terms acceptance, even when they carry the same versions; otherwise a coordinator our team uploaded for (#1124) would never see the screen (author's call).
- **Response:** `{ outstanding: boolean, audience: 'aggregator' | 'org', terms_version, privacy_version, org_ids?: string[] }`. `org_ids` lists the orgs still to accept, for owners only. No personal data.
- **Implementation:** a small read service, `services/consent-status.ts`, querying `consent_record` with Drizzle. The ledger package stays write-only. For owners, use `Actor.orgs`: it lists only active owned orgs and carries `orgType` and `isDefault`.
- The check ignores the row's `network` and `brand` columns; versions are compared within the instance's one brand (author's call).

**`POST /v1/user/consent`**, same access and caller. Body `{ terms_version, privacy_version }`. These are the versions the screen showed.

- **Refuse** with 409 `CONSENT_VERSION_CHANGED` when they are not the current versions, so the person re-reads.
- **Coordinator:** writes one `recordRegistrationConsent` row: `subjectType: 'user'`, the current versions, `validTill = now + MAX_CONSENT_VALIDITY_MS`, `source: 'first-login'`.
- **Owner:** writes one row per outstanding org, in **one transaction** using `withExecutor`, so it's all or nothing.
- **Idempotent:** subjects already accepted are skipped.
- **Response:** `{ recorded: number }`.
- The ledger's `recordRegistrationConsent` already takes an optional `source` (default `'registration'`), so no ledger change is needed. `network` and `brand` come from `resolveActiveNetwork()`, as the other writers do.

**Profile view.** Add `'first-login'` to `REGISTRATION_CONSENT_SOURCES` (`user-store/postgres.ts:62`), so the profile shows the acceptance.

**Upgrade check V1** already counts `'first-login'` (#1118, Task 4). No change here.

### Web (`apps/web`)

**Session.** Add `termsStatus?: 'ok' | 'outstanding' | 'unknown'` to `SessionData` (`lib/session/interface.ts`).

**Session field.** `termsStatus` goes into the Zod `SessionDataSchema` too, not only the TypeScript type, or the session store drops it.

**Callback** (`api/auth/callback/route.ts`), after `settleInvitedLogin` and before creating the session:
- call status with the new access token. No session exists yet, so `callApi` can't be used: follow `lib/invite-activation.ts` (a direct `fetch` with a bearer token and its own named timeout);
- `outstanding: true` sets `termsStatus = 'outstanding'` and lands on `/accept-terms?returnTo=<landing>`;
- `outstanding: false` sets `'ok'`;
- any failure sets `'unknown'` and lands as today (fail-open).

**Layouts.** Both `(protected)/layout.tsx` and `(console)/console/layout.tsx`, after their existing session checks:
- `'outstanding'` redirects to `/accept-terms?returnTo=<path>`;
- `'unknown'` re-calls status once per request and writes the result into the session. Only a confirmed `outstanding` redirects, so an API outage never locks people out;
- `'ok'` or absent (sessions created before this deploy) proceed. Absent is treated as `'unknown'`: re-checked once, then stored.

**`/accept-terms` page** (`app/accept-terms/`, outside both protected groups, but needing a session):
- **No session:** redirect to login.
- **Server side:** load documents with `loadConsentContent()`, picking `aggregator` or `org` from the status `audience`. If status says nothing is outstanding, redirect to `returnTo`.
- **Client:** render `ConsentGate` open with no `onCancel`.
- **On accept:** POST the shown versions to the BFF route. On success, go to `returnTo`. On 409 `CONSENT_VERSION_CHANGED`, reload so the new text shows.
- **Exit:** a plain "Log out" link (the only way out without accepting).
- **`returnTo`** must be a same-origin path. Move `isSafeReturnTo` out of `api/auth/login/route.ts` into a shared module and reuse it.
- **No redirect loop:** if the session says `outstanding` but a fresh status says nothing is outstanding (accepted on another device), the page writes `termsStatus = 'ok'` before redirecting.

**BFF route `POST /api/consent`** (`app/api/consent/route.ts`):
- same-origin check (`lib/same-origin.ts`);
- calls `POST /v1/user/consent` via `callApi`;
- on success sets `session.termsStatus = 'ok'`.

**BFF API routes.** The layout guard covers pages; the `/api/*` route handlers (dashboard, exports, bulk uploads, console) would still work for a marked session. So `callApi` / `getFreshAccessToken` (`lib/upstream-client.ts`) refuses with 403 `TERMS_REQUIRED` while `session.termsStatus === 'outstanding'`, except for an allow-list: the consent status and accept calls, `/v1/user/read/me`, and support. One check covers every proxy route (author's call, to meet the "no way round" anti-goal).

**Console when the API is down.** The console layout already leaves when `/v1/user/read/me` fails (`leaveConsole('unavailable')`), so fail-open only changes behaviour in the coordinator portal.

**Text.** English, Hindi and Kannada for:
- the page heading;
- the agree label (reuse the registration wording if it fits);
- the log-out link;
- the "terms changed, please read again" message.

### What a person sees

```
Log in (email code) → [terms outstanding?]
   no  → dashboard / console, as today
   yes → "Before you continue" — terms + privacy, scroll to end, ☐ I agree → Continue
          (or Log out)
        → dashboard / console
```

### Tests

**API:**
- status for a coordinator: accepted current, accepted older version, expired, none;
- status for an owner with two orgs, one accepted;
- root and Default orgs skipped;
- POST writes one row (coordinator) or one per outstanding org (owner) with `source='first-login'`;
- an owner's multi-org write is all or nothing;
- 409 on stale versions;
- a second POST writes nothing;
- RBAC and edge route-table entries.

**Web:**
- callback sets each `termsStatus` and lands right;
- `callApi` refuses a marked session with `TERMS_REQUIRED` and lets the allow-list through;
- both layouts redirect `outstanding`, re-check `unknown`, and pass `ok`;
- `/accept-terms` redirects when nothing is outstanding;
- accept posts and clears the mark;
- the BFF refuses cross-site.

**Integration (Postgres):**
- a coordinator loaded by `org-loader` shows outstanding;
- after POST, V1 counts it and the profile shows the acceptance.

### Runbook

Add to `docs/org-structure-loader-runbook.md`:
- deploy this before telling anyone to log in;
- the read-only "who has accepted" query: `consent_record.source = 'first-login'` joined to provisioned users and orgs.

## Effect on existing instances

When this ships on an instance, anyone whose last acceptance is of an older version than `consent.json`'s current one, or has expired, sees the screen once at next login. UP is a fresh instance, so only loaded accounts are affected there. This is the behaviour Aniket chose.

## Left to the builder

- Exact names, the i18n keys, and whether the status call lives in a small `lib/terms-status.server.ts` helper shared by the callback and layouts (recommended).
- Whether `ConsentGate` needs a tiny prop for a page (not modal) layout. Keep any change additive.
