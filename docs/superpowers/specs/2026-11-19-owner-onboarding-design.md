# Owner onboarding through their own coordinator account (#1121)

**Ticket:** aggregator-dpg#1121 (child of bluedots-infra-deployments#146; PRD bluedots-program#33, capability 2)
**Status:** design, awaiting approval (all architect questions answered 19 Nov 2026)
**Base:** `origin/feature` @ `011a95c3`. After merge into `feature`, also merged into `hotfix/up-speedrun`.

## 1. Intent

Org owners must be able to onboard seekers and providers in their own org: create QR / sign-up links, run bulk uploads, and see their own onboarding counts. Today they can't, even though `org_admin` already holds `profiles.onboard`. The reason is that an admin account has no Signals org to act in. Each coordinator account has its own Signals org (`external_id` = `users.id`). That org is the PII and data isolation boundary, and link slugs come from it.

The fix is to give the owner a normal coordinator account in their own org, on the same contact and the same Keycloak login, and let the web switch between the console and that account. This is option A in `local_docs/2026-11-19-owner-onboarding-architect-note.md`.

## 2. Decisions recorded (19 Nov 2026)

| # | Question | Answer |
|---|---|---|
| 1 | Relax H-5 to one account per type per login (A), or start `user_orgs` now (B)? | **A.** `user_identities` unique becomes `(provider, subject, user_type)`. |
| 2 | How is the acting account chosen? | **In the web session, checked by the API** (a header). No new Keycloak client or scope. |
| 3 | Network admins too? | **Not now.** Only org owners (owners of an `aggregator` org). |
| 4 | Is the owner's coordinator account a team member? | **Yes.** It shows in My Team (tagged "You") and counts in Team Members and Active. The participants it onboards count in org totals and console dashboards like any coordinator's. |
| 5 | Web layout | **Switch shells.** One new console sidebar item opens the existing coordinator shell, which gets "← Back to console". The merged-sidebar alternative was rejected. |

## 3. Goals, non-goals, anti-goals

**Goals**
- An owner adds themselves to My Team in one step and then onboards in their org exactly as a coordinator does: links, QR, bulk upload, Onboarding and My Blue Dots counts.
- The console behaves exactly as before.
- No change to Signals, to the per-coordinator Signals org, to link slugs, to `onboarded_by`, or to PII-decrypt ownership.

**Non-goals**
- A Signals org per aggregator org. Re-homing `onboarded_by_org_id`.
- The `user_orgs` membership table. This design must not add anything `user_orgs` would have to undo; the owner's coordinator account becomes an ordinary membership row later.
- Network admins (root owner) onboarding.
- Campaign routes (`apps/api/src/campaign/auth.ts` requires the `signalstack_org_id` claim). They are not part of the coordinator onboarding shell and stay unavailable to an acting owner.

**Anti-goals** (failure even if it "works")
- The owner's console token turning into a coordinator token. Setting `aggregator_id`, `decision_made`, `signalstack_org_id` or coordinator `roles` on the owner's Keycloak user would do that.
- Any caller using a coordinator account that isn't linked to its own login.
- A second Keycloak user or email for the owner (the realm has `duplicateEmailsAllowed: false`, and it would break one-person-one-contact).

## 4. Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **A. Second coordinator account, same login; acting account chosen per session** | Small change; uses P2-D3 (one admin + one coordinator account per contact) as written; RBAC rule "a role applies only to its account type" holds | **Chosen** |
| B. `user_orgs` membership now | Long-term direction, but a schema change across tenant data, an RBAC rule rework and a resolver rework. Several weeks | Rejected for now |
| Acting via a separate Keycloak client or scope that adds `aggregator_id` | No header, but a new client, mapper and login flow per realm; two tokens per browser | Rejected (decision 2) |
| Signals org per aggregator org | Contradicts the per-coordinator Signals org; needs a tenant migration | Rejected |
| Web: merged console sidebar | One sidebar, but two "My Blue Dots" entries, and every coordinator page has to work in two layouts | Rejected (decision 5) |

## 5. Design

### 5.1 Data: one login, at most one account per type

`packages/db-schema/src/schema.ts:335-349` (`user_identities`): PK `(user_id, provider)`, `UNIQUE (provider, subject)` named `user_identities_provider_subject_unique`.

- Add `user_type` (same enum as `users.user_type`, NOT NULL) to `user_identities`, backfilled from `users`.
- Replace the unique with `UNIQUE (provider, subject, user_type)`.
- Keep `user_type` consistent with `users`. *Builder's call:* use a composite FK `(user_id, user_type) → users (id, user_type)`, which needs a unique on `users (id, user_type)`, or set it in every write path in `db/account-writes.ts` with a test. Prefer the FK if Drizzle expresses it cleanly.
- Generate the migration with `pnpm db:generate`. Never hand-edit it. Existing rows are valid by construction, since each subject has exactly one row today.
- Audit every `userOf` caller (including `organisation-root.ts:~513` and the lazy `recordLoginIdentity`); each states which type it wants. `IdentityStore.userOf(provider, subject)` (`services/identity-store/*`) becomes type-aware: `userOf(provider, subject, userType?)`. Without a type it returns the **admin** account when one exists, else the coordinator. That keeps today's behaviour: "a coordinator login without the claim is still a coordinator", and an owner token without a header is an owner. `IdentityTakenError` and the link writers check `(provider, subject, user_type)`.
- Boot reconcile, `services/organisation-root.ts:14-15, 155-172, ~535`: remove the `owner_is_coordinator` refusal. A coordinator may also own the root or the Default org; at most one account per type per login. `owner_owns_other_org` stays. On a deployed instance where a configured owner was refused for this reason, the next boot links the admin row to the existing login (`ownerSubject`, ~525-546). That is intended; call it out in the release notes.
- Docs: update H-5 in `docs/rbac/phase-5-rbac-handoff.md:30`, and `user-org-target-model.md` line 59 ("one login maps to one account" → "at most one account per type").

### 5.2 Creating the owner's coordinator account: "Add myself to My Team"

The usual invite → activate path exists to verify an email address and create a Keycloak user. Neither applies here: the owner is signed in and their Keycloak user already exists. So the self path is one owner-only API call, not an emailed invite. *(My call; the handoff suggested reusing invite → activate. The steps after creation are the same pipeline.)*

`POST` on the owner's org (route name is the builder's call, next to the coordinator-invite routes), with body `{ serves: ProfileType[] }`. The owner picks Seekers and/or Providers in a small dialog. Behaviour:

1. The caller must be an admin actor who owns the target active `aggregator` org. Refused for the Default org (`slug = 'default'`, which the root owner may own) and for any admin who owns the root (decision 3). *(My call.)*
   - One coordinator account per contact (`UNIQUE (contact_id, user_type)`). An owner of several aggregator orgs picks the org in the dialog; once the account exists, self-add is refused in every other org. *(My call.)*
2. Refuse with a conflict if the contact already has a coordinator account (`UNIQUE (contact_id, user_type)` would anyway).
3. Create the coordinator `users` row on the owner's existing `contact`: `org_id` = the org, `name` from the admin row or token, slug as for any coordinator, `serves` from the body, status `pending`.
4. Link the identity `(keycloak, <owner sub>, coordinator)` to the new row.
5. Run `approveCoordinator` (`services/decisions/coordinator.ts:70`) with a **self branch** (below). It upserts the Signals org (idempotent on `external_id`) and stores `signalstack_org_id` on the row. The coordinator base role comes from membership (`baseRoleOf`) as usual; there are no invite default roles.
6. Audit-log it as an owner self-add.

**Self branch in `approve()`** (`coordinator.ts` ~95-160). When the coordinator's login subject is also linked to an admin account (a "shared login"):
- Find the Keycloak user through `user_identities`, not the `aggregator_id` attribute. Today `loadCoordinatorAndUser` would return `idp_missing`.
- **Skip every Keycloak write on the shared user**: `enableUser`, `setUserDecision('approved')`, `setAttributes({signalstack_org_id})`, and the failure paths `restoreInvited` / `compensate` (~167-173), which would set `decision_made=invited` on the owner or disable them. The row's `signalstack_org_id` and `status` are the only source of truth for this account.

The three places that refuse an owner's own email are **not touched**: `assertNotOrgOwner` (`routes/aggregator-registrations.ts:232, 285-289`), `mint.ts` `other_account` (`services/invites/mint.ts:126-151, 272`), and `assertContactFree` / `assertNotInKeycloak`. Those refusals stay right for the public and invite paths. The self path doesn't go through them. *(On `hotfix/up-speedrun` those checks have moved to `services/registration/coordinator-create.ts`; also untouched.)*

**Leaving and removal:** deactivating or removing the owner's coordinator account from My Team works as for any coordinator, except that steps acting on the Keycloak user (disable user, revoke sessions, drop attributes) are skipped for a shared login. Revoking its roles in the DB still applies. The owner can add themselves again later, which reactivates the existing row.

### 5.3 Acting account per session (API)

The owner's token is never changed. The web sends the chosen account in a header on every API call: **`X-Acting-Account: <coordinator users.id>`**.

**Coordinator-route auth** (`services/auth/access-token.ts`, `authenticate` ~105-145 and `requireApproved` ~190-215). Acting is added in `requireApproved` only, used by `routes/registration-links.ts`, `bulk-uploads.ts`, `dashboard.ts` and `onboarding.ts`. `authenticate` alone (e.g. `routes/aggregator-profile.ts:375`, whose PATCH writes Keycloak contact attributes on the shared login) does **not** accept acting. In acting mode the coordinator shell's "Account Details" links to the console's profile page instead. *(My call.)*
- **Token has `aggregator_id`:** today's path, unchanged. If an `X-Acting-Account` header is present and differs from the claim, return `403`. A plain coordinator can't use someone else's account.
- **Token has no `aggregator_id` but has the header:** accept only if all of these hold:
  1. `user_identities` has `(keycloak, token.sub, coordinator)` → that exact `users.id`;
  2. the same subject also links an admin account (a shared login; the only case this path exists for);
  3. the coordinator row exists and its org is active.

  Then build the `AuthContext` from the **row**, not the claims: `aggregatorId` = row id, `serves` = row serves, `decisionMade` = row status mapped to `approved/pending/rejected`, `signalstackOrgId` = row value. Identity fields (email, names, phone, azp) still come from the token. `requireApproved` runs its usual approval check against that context.
  - **Skip** `backfillSignalstackOrgId` (it writes the Keycloak attribute) and `recordLoginIdentity` (already linked).
  - If the row has no `signalstack_org_id`, return `NOT_APPROVED` (or `SERVICE_UNAVAILABLE`, builder's call); never backfill onto the owner's Keycloak user.
- **Neither:** `MISSING_AGGREGATOR_ID`, as today.
- Cache the acting lookup per request only. If the coordinator row is deactivated, the next request fails.

**Actor resolver** (`services/auth/actor/store.ts:72-87`). `ResolveActorInput` gains `actingAccountId?`. When it is set and there is no `aggregator_id`, run the same three checks, then call `this.coordinator(id)`. Otherwise use the type-aware `userOf` as in 5.1. Every route that resolves the actor (`/v1/user/read/me`, console routes) sees the coordinator actor while the header is present. That is why the web must not send it from the console (5.4).

**Roles claim sync** (`services/authz/token-roles.ts:107-135`). Today `idpUserOf(coordinatorId)` resolves to the shared Keycloak user, and `writeRoles` would overwrite the owner's `roles` attribute with coordinator roles. Rule: **for a shared login, the admin account owns the Keycloak `roles` attribute.** A coordinator account on a shared login never writes it directly; how its roles reach the edge is set in "Edge" below.

**Edge (Envoy + OPA). Route permissions are enforced only here.** `route-access.ts:204-209` checks nothing; `policy/rbac/edge.rego:58-77,139-141` decides from the token's `roles` claim; Envoy fronts the API locally (`local-setup/docker-compose.yml`) and in the Helm chart (`bluedots-automation` `helm/aggregator/charts/api`). `rbac-edge-enforcement.md` "Status: proposal" is stale; fix it in this work.

An acting request carries the owner's token, so the claim holds the owner's admin roles. `org_admin` has `profiles.view`/`onboard`/`export` but not `profiles.view_pii`, which the coordinator base role has and which `GET /v1/bulk-uploads/:id/errors.csv` and `POST /v1/dashboard/export/profiles` need. **Decision (option A, 19 Nov 2026): carry the coordinator account's roles in the same claim, tagged with its id; the edge uses them only for a matching header.**

- **Claim format.** For a shared login, the `roles` attribute holds the admin account's role keys as today, plus one entry `acting:<coordinator users.id>:<roleKey>` for each effective role of the linked coordinator account (from `tokenRolesOf`, `token-roles.ts:89`). Name the prefix as one exported constant used by the API, the Rego policy and the tests.
- **Sync.** The roles sync for a shared login is keyed on the Keycloak user: any role change on either account (self-add, role assign or expiry, coordinator deactivated) recomputes and writes the whole list under the existing per-user lock. A deactivated or removed coordinator account contributes no `acting:` entries.
- **Edge** (`policy/rbac/edge.rego`):
  - With no `X-Acting-Account` header, the effective roles are the claim entries **without** the `acting:` prefix, so the owner console is unchanged and tagged entries never grant anything.
  - With the header, the effective roles are **only** the entries `acting:<header value>:<k>`, mapped to `k`; the owner's plain roles don't count. No matching entry means no roles, so `403`.
  - `permissions` and the `signed_in`/`self` `count(roles) == 0` check use the effective roles.
  - Envoy's gRPC ext_authz already forwards `x-acting-account` to OPA (`infra/envoy/envoy.yaml:95-103`). The Helm `opa-authz.rego` / `edge-init.js` in bluedots-automation mirror the policy and must get the same change.
- **The API still verifies the link** (the three checks above) and builds the context from the row. The edge decides the permission and the API decides the identity and the data scope, so neither trusts the header alone.
- **Token freshness.** After self-add, the BFF's `POST /api/auth/acting` refreshes the token before it stores the acting account, so the first acting request carries the tagged roles. Changes later follow the usual sync and refresh lag.
- **Other claim readers.** Audit every consumer of the `roles` claim (API, web, the Helm policy copy) so that `acting:` entries are ignored where they aren't expected.
- **Doc.** Update `rbac-edge-enforcement.md` (status, §3.2 claim format, acting-account rule).

### 5.4 Web

The session is already stored on the server (Redis, `apps/web/src/lib/session/interface.ts`), so adding a field is cheap.

- **Session:** add `actingAccountId?: string` to `SessionData`. Changing it clears the `consoleActor` cache.
- **BFF routes:**
  - `POST /api/auth/acting` `{ accountId }` checks `/me`'s `own_coordinator_account_id` equals `accountId`, refreshes the token and checks it carries `acting:<accountId>:` entries (else `409 ACTING_NOT_READY`), then stores the id and redirects to `/onboarding`. Otherwise it returns `403`.
  - `DELETE /api/auth/acting` clears it and redirects to `/console`.
- **`callApi`** (`lib/upstream-client.ts:65-80`): when `session.actingAccountId` is set, add `X-Acting-Account`. Other BFF proxies that call the API with the user token (`lib/bff-service-proxy.ts` and any others found) do the same.
- **`(protected)/layout.tsx:36-44`:** accept the session when the token has `aggregator_id` **or** `session.actingAccountId` is set. An owner without an acting account still goes to `/console`. The footer and `user` show the coordinator account's name, and "Coordinator · <org name>".
- **`(console)/console/layout.tsx`:** if `session.actingAccountId` is set, redirect through `DELETE /api/auth/acting?returnTo=<path>`. Typing a console URL drops out of acting mode, so console calls never carry the header.
- **Console sidebar:** a "My onboarding" group with **"Onboard participants"**, shown when `/me` reports that the owner has a coordinator account. Add a field to `MeResponse` (for example `ownCoordinatorAccountId`) from the admin actor lookup: a coordinator row linked to the same subject. Clicking it calls `POST /api/auth/acting`.
- **Coordinator shell:** add a "← Back to console" item above OVERVIEW in acting mode only, and a dismissable banner on Onboarding: "You're onboarding as yourself in <org>. Counts here are only your own."
- **My Team:** an "＋ Add myself to My Team" button next to "Invite team members". It is shown only to owners of an aggregator org without a coordinator account, and opens the profile-type dialog that calls the API in 5.2. The owner's own row gets a "You" tag.
- Mode is per session, so two tabs share it. Accepted.

Mockups: `.superpowers/brainstorm/83432-1795085070/content/owner-onboarding-nav.html` (workspace root), option A.

### 5.5 Counts

No special-casing. The account is an ordinary coordinator in `users.org_id`, so My Team, Team Members, Active, the console dashboards and org totals include it and its participants. Coordinator-shell counts are the account's own, as for any coordinator.

## 6. Tests

- **Migration:** existing `user_identities` rows get the right `user_type`. A second row for the same subject with another type succeeds; the same type fails.
- **Resolver / auth:**
  - An owner token with no header resolves to the admin (console unchanged; existing console tests stay green).
  - An owner token with the header resolves to the coordinator, and links, bulk uploads, dashboard and onboarding return only that coordinator's data.
  - The header is refused when: the account belongs to another login; the account is an admin row; the token is a coordinator token with a different header value; the row is deactivated; the row has no Signals org id.
  - A coordinator token with no header behaves exactly as today.
- **Self-add:** creates the row, links the identity and approves. It writes **no** Keycloak attributes (`aggregator_id`, `decision_made`, `signalstack_org_id`, `roles`) and doesn't enable or disable the user. It is refused for a root-only owner and for a second self-add. The public and invite refusals are unchanged.
- **Roles sync:** a shared login's `roles` attribute holds the admin roles plus `acting:<id>:<role>` entries for its coordinator account. They are recomputed when either account changes and dropped when the coordinator account is deactivated.
- **Edge (Rego unit tests plus the shared vectors):**
  - With no header, tagged entries grant nothing.
  - With the header, only that account's tagged roles apply and the owner's plain roles don't.
  - A header naming another account gives `403`.
  - `errors.csv` and the PII export are allowed when acting and refused for the owner console.
  - A plain coordinator token is unaffected.
- **Boot reconcile:** an owner who also has a coordinator account is accepted; `owner_owns_other_org` is still refused.
- **Web:** the layout gates for both shells; the console drops acting mode; `callApi` adds the header only in acting mode; the sidebar item and the "Add myself" button show only when they should.

## 7. Delivery

- One branch per block, cut from `feature`, with stacked PRs per `.claude/rules/pull-requests.md`:
  1. **api:** schema, migration, identity store, resolver, auth, self-add, roles sync, boot reconcile, `edge.rego` with its tests, `routes.json`, docs.
   - No infra PR: Envoy's gRPC ext_authz already forwards all request headers to OPA.
   - The Helm policy and config copy is a bluedots-automation Task, which must deploy with or before the API.
  2. **web:** session, BFF routes, layouts, sidebar, My Team button and tag.
- After both merge into `feature`, merge into `hotfix/up-speedrun`. That branch has `coordinator-create.ts`, so expect conflicts around the registration checks; this design doesn't edit them.
- Post decisions 1–5 as a comment on #1121 when this spec is approved.
- **Done when:** on UAT, an owner adds themselves, switches to "Onboard participants", creates a link, runs an upload and sees the counts; the console works as before; the owner's console token, decoded, has no `aggregator_id`, `decision_made` or `signalstack_org_id`.

## 8. Left to the builder

- Route names and the exact `MeResponse` field name.
- Composite FK vs write-path discipline for `user_identities.user_type` (5.1).
- `NOT_APPROVED` vs `SERVICE_UNAVAILABLE` for an acting row with no Signals org id.
- The banner wording and whether it is dismissable per session.

## 9. Decision: whose permissions apply while acting

**Option A**: the coordinator account's own roles, carried in the shared login's `roles` claim as `acting:<id>:<role>` entries and applied by the edge only with a matching `X-Acting-Account` header (§5.3 "Edge").

| Option | Why not |
|---|---|
| B. The edge passes acting requests through; the API checks the coordinator's DB roles | A second enforcement point (against decision E6); a pass-through bug skips the edge entirely |
| C. The owner's own roles apply | Org Admin lacks `profiles.view_pii`, so no bulk-upload errors file or PII export; granting it changes PII policy for every owner |
