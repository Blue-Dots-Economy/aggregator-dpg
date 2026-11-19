# Org structure loader: design

**Issue:** #1118, part of the instance speed-run (bluedots-infra-deployments#146)
**Date:** 2026-11-19
**Status:** approved 2026-11-19

## Why

A new instance has to be ready before any real person logs in. Our team, which has cluster access, loads the org structure product sends: orgs, their owners and their coordinators. Then it creates QR links (#1119) and runs bulk uploads (#1124) for each coordinator. People log in later and accept the terms at that point (#1120).

Today every org and coordinator joins by invitation. The invitee fills in the form and accepts the terms, and their first email sign-in approves the account. Nothing can be created for someone else, and a coordinator can't have links or uploads until approved, because approval creates their Signals org. The loader builds the whole tree in one run, with everyone already approved.

## Goals

- One operator command, shipped in the API image and run in the API pod, that loads orgs, owners and coordinators from two CSV files.
- Everyone created goes through the same create and approve code as the invite path, so the result can't be told apart from an invited, activated account, apart from the missing terms record.
- A dry run that checks the whole input and reports every problem, writing nothing.
- Safe to run again: rows that already exist are reported and skipped. A run that stopped part-way picks up where it stopped.
- A report of what was created, skipped or failed.

## Non-goals

- No emails to anyone.
- No terms or privacy acceptance recorded. Acceptance happens at first login (#1120).
- No QR links, bulk uploads, editing, moving or deleting. Those are #1119 and #1124; the loader only creates.
- No UI and no HTTP endpoint.
- No change to how invites behave for real users.

## Anti-goals: a failure even if it works

- A second way of creating accounts whose rules drift from the invite path.
- Any record suggesting a person accepted terms they never saw.
- Half-created accounts left behind that block a rerun or a later real invite.
- Personal data in logs or the report beyond what the operator supplied (ids, emails in the report file only).

## Constraints

- Org names are unique, case-insensitive. Each email and each phone belongs to one person across owners and coordinators.
- The tree limits come from the network config (`aggregator.organisation.hierarchy`) and are enforced by the org store.
- A coordinator can only be approved once their org is active, and must serve at least one of the network's profile types.
- Approval writes the Signals org, the Keycloak attributes and the token roles. Token roles are synced fire-and-forget through `requestTokenRolesSync`, which does nothing unless the RBAC runtime is initialised (`services/authz/runtime.ts`).
- The registration schemas (`org-registration.v1.json`, `registration.v1.json`) require `consent`.
- `user_identities` is written by approval (`recordLoginIdentity` in `decisions/coordinator.ts`). That's fine: first login is tracked by the terms acceptance (#1120), not by this table.
- Repo rules apply: base-class and interface patterns, `Result` errors, structured logging with no PII, tests (`.claude/rules/`).

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Move the create steps out of the two invite-accept routes into shared services, with no change in behaviour. The routes and the loader both call them; the loader then calls `approveOrg` / `approveCoordinator`. | One code path for validation, slugs, contacts and Keycloak, so no drift. A moderate refactor of the accept routes, covered by their existing tests. |
| B | The loader calls the stores and the Keycloak adapter directly, copying what accept does. | Leaves the routes alone, but duplicates the rules, and they'll drift. |
| C | The loader drives the invite and accept APIs in-process with internal tokens. | Reuses everything, but has to work around the invite emails and token checks. |

Aniket picked A.

## Where the code lives

All code written for this exercise lives on one **side branch**, outside the main release cycle. Nothing of it is merged to `feature`, `develop` or `main`. The operations team reconciles the instance with the main release cycle afterwards.

- **Branch:** `hotfix/up-speedrun`, cut from `develop` at `a8cf36ff`. Work lands on it through PRs from per-ticket branches.
- **Release:** an instance tag such as `202611-s2-rc1-up1` (matches the `20*-s*-rc*` image-build pattern), like the earlier `202609-s2-rc1-alimco`.
- It is not a `release/**` branch, so `sync-release-branch.yml` opens no carry-back PRs. CI is run by hand (`gh workflow run ci.yml --ref <branch>`) so the release gate passes.
- **On the branch:**
  - the loader command;
  - the create services it needs, split out of the accept routes;
  - the consent rule change below;
  - the terms screen at first login (#1120);
  - the other speed-run commands (#1119, #1124);
  - the runbook.
- Product features that belong to every instance (#1121 owner onboarding, #1122 QR form) are built through the normal path into `feature` and also merged into the side branch, so UP gets them in the same release.

## Consent rule (side branch)

Today every owner and coordinator account has a terms acceptance in the consent ledger, written in the same transaction as the account. The upgrade tool's check `coordinator_without_consent` (`scripts/sql/cleanup-verify.sql`) requires the count of coordinators with none to be zero.

**On the side branch:** every account has a terms acceptance, or was **provisioned by an operator** and hasn't accepted yet.

- **"Provisioned by an operator"** is marked by the existing `created_by` column on `users` and `organisations`: `provisioned:<operator>`. No new table or consent source.
- The terms screen at first login (#1120) records the acceptance with `source = 'first-login'`.
- **The check:**
  - counts registration, backfill and first-login acceptances;
  - skips provisioned accounts that haven't accepted yet.
- The invite-accept routes still always write consent. Only the loader path creates without it.

## Bulk upload on a coordinator's behalf (#1124)

**Why:** our team, which has cluster access, runs the first bulk uploads for loaded coordinators before any of them logs in. The team taking over operations has no cluster access yet.

**Command:** `apps/api/src/tools/bulk-upload.ts`, shipped in the API image like the loader, and run in the API pod:

```
node dist/tools/bulk-upload.js --coordinator <email or user id> --type <profile type> --file <path.csv> --operator <name> [--skip-rate-limit]
```

Exit codes: 0 ok, 1 refused or failed, 2 usage.

**How it works:**
1. Split the create and start steps of `POST /v1/bulk-uploads` and `POST /v1/bulk-uploads/:id/start` (`apps/api/src/routes/bulk-uploads.ts`) into a shared service (`services/bulk-upload/`), with no change in route behaviour. The routes and the command both call it, the same approach as the loader's create services.
2. **Preconditions.** The command refuses unless:
   - the coordinator exists and is `active` (loaded by the org loader or registered normally);
   - they serve the given profile type;
   - the file passes the same size and header checks as a portal upload.
3. **Storage and processing.** The command writes the CSV to object storage with `ObjectStorageBase.put` under the same bulk-upload area and key layout the portal uses, instead of a browser presigned upload. It then runs the shared start step, which enqueues `bulk-file-process` as usual. Processing, row errors, the errors report, statuses and the Onboarding counts are unchanged from a portal upload.
4. **Who did it.**
   - `bulk_uploads.uploaded_by` stays the coordinator's user id. The column is a required user id; no migration.
   - The operator is recorded in the attestation's consent `source`: `bulk_upload:<uploadId>:v<n>:provisioned:<operator>`. The operator part is built with `provisionedBy` from `services/provisioned.ts`; no other code spells the prefix.
   - The subject stays the coordinator (`subject_type = 'user'`), as for a portal upload.
   - The command's logs carry the upload id, the coordinator id and the operator name, never row data.
5. **Rate limit.** The usual per-coordinator limit (`checkBulkUploadRate`) applies by default. `--skip-rate-limit` skips it for one run, and the log records that it was skipped. The runbook says to use it only for the initial load.
6. **Output.** The upload id and final status are printed once processing finishes (the command polls the upload status), plus the path of the errors report when any rows failed.
7. **Runbook:**
   - copy the file in with `kubectl cp`;
   - run the command, reading the status and the errors report;
   - delete the file;
   - nobody is told to log in until the terms screen (#1120) is live.

**Open question (product and legal):** can our team, as operator, attest that the source team holds the participants' consent? The command can be built before the answer, but must not be run on UP without it.

**Depends on:** `services/provisioned.ts` (commit `86f9e75d`, on this branch).

## Returning to the main release cycle (operations team)

The runbook lists what the main release cycle does not know about, so the team can reconcile before moving UP back:

1. **Provisioned accounts that haven't logged in yet.**
   - The main release has no terms screen at login, so these people would never see the terms.
   - The main release's `coordinator_without_consent` check fails on them, which blocks the instance-upgrade tool.
   - Before switching back, either wait until all of them have logged in, or carry the consent rule and the terms screen into the main release.
   - A read-only query in the runbook counts them.
2. **`source = 'first-login'` acceptances.** The main release's check doesn't count this source either, so it needs the same carry-over or a check fix.
3. **The `provisioned:<operator>` marker** on `created_by` / `updated_by` is plain data and needs nothing.
4. The side branch is then closed.

## Design

### Command

`apps/api/src/tools/org-loader.ts`, compiled to `dist/tools/org-loader.js` like the instance-upgrade tool, and run in the API pod with the API's ConfigMap and Secret:

```
node dist/tools/org-loader.js check --orgs orgs.csv --coordinators coordinators.csv
node dist/tools/org-loader.js apply --orgs orgs.csv --coordinators coordinators.csv --operator <name> [--report out.csv]
```

- `check` validates everything and writes nothing.
- `apply` runs the same checks first and refuses to start if any fail. It then creates in order and stops at the first failure.
- Either file may be omitted, for example coordinators for orgs that already exist.
- Exit codes: 0 ok, 1 refused or failed, 2 usage.
- The files are copied into the pod (`kubectl cp`) and removed afterwards (runbook).

### Input

**orgs.csv**

One row per org, in any order:

| Column | Notes |
|---|---|
| `name` | Required. Org display name |
| `parent` | Name of the parent org: one in this file, or one that already exists. Blank means the network facilitator root |
| `owner_name`, `owner_phone`, `owner_email` | Required |
| any other column | Any extra field the instance's org form requires (e.g. `organisation_type`, `management_type`, `aggregator_type`), named as in `org-registration.v1.json` |
| `address_*` | Optional. Same parts as the form address block |

**coordinators.csv**

One row per coordinator:

| Column | Notes |
|---|---|
| `org` | Org name, from the file or already existing |
| `name`, `phone`, `email` | Required |
| `profile_types` | Required. Separated by `;`, each one a network domain id |
| any other column | Any extra field the coordinator form requires, named as in `registration.v1.json` |

Each row becomes the same body the matching accept route takes, without `invite` and `consent`, and is checked with the same schema validator. Consent is taken out of the schema's `required` list for the loader only, never for the routes. The runbook ships a sheet template per instance, generated from its two schemas.

### Checks (both commands)

1. **Per row:** schema, phone format, profile types, and no duplicate name, email or phone inside the files.
2. **Tree:** every `parent` resolves; no cycles; the depth and child limits hold once the whole file is applied.
3. **Against the database and Keycloak:**
   - an org name that already exists with the same owner email is "already loaded" and skipped;
   - with a different owner, it's an error;
   - an email or phone that already belongs to another person is an error;
   - a coordinator email that already exists in the same org with the same details is "already loaded"; anywhere else, it's an error;
   - an owner email that already owns other orgs is allowed. One owner can own several orgs, and they reuse the same contact, admin account and Keycloak user.
4. The report lists every problem with its row number. `check` stops there.

### Apply order

1. **Orgs, parents before children.** For each org:
   - Run the shared create-org service with no consent hook. It creates the contact, admin account, org row, Keycloak group and owner user, stamped on the org.
   - For an owner who already exists, reuse their Keycloak user instead of creating one.
   - Then call `approveOrg({ decidedBy: 'provisioned:<operator>' })`, which activates the org and grants the owner access.
   - Then set the owner's `decision_made` to `approved`, as activation does.
2. **Coordinators.** For each coordinator:
   - Run the shared create-coordinator service with no consent hook and no invite id. It creates the user row with a Signals slug and the Keycloak user.
   - Then call `approveCoordinator({ decidedBy: 'provisioned:<operator>' })`, which creates the Signals org, sets the Keycloak attributes and activates the row.
3. **Token roles.** The tool initialises the RBAC runtime at start and awaits the role sync for every account it touched, instead of the fire-and-forget call. A sync failure counts as a failed row.
4. **Resuming:**
   - An org or coordinator left `pending` by an earlier stopped run is approved, not recreated.
   - Create failures roll back what they created, as the accept routes already do (for example `discardHalfCreatedOrg`).

### Shared services (the refactor)

| Today (private, in the route) | Becomes | Used by |
|---|---|---|
| `aggregator-orgs.ts`: `checkOrgSubmission`, `createOrgRecord`, `provisionOrgLogin`, `discardHalfCreatedOrg`, `findOwnerContactClash` | `services/registration/org-create.ts` | Org accept route; loader |
| `aggregator-registrations.ts`: `checkCoordinatorSubmission` (minus the rate limit), `createCoordinatorRow`, `createCoordinatorLogin`, `createAggregatorWithSlug`, `assertContactFree` | `services/registration/coordinator-create.ts` | Coordinator accept route; loader |

The services return `Result` values. The routes map them to the same HTTP errors as today, so route tests and responses don't change. The consent hook becomes an optional parameter: the routes always pass it, the loader never does. Invite claiming, rate limits and `assertNotOrgOwner` stay in the routes.

### What the result looks like

| | Org owner | Coordinator |
|---|---|---|
| DB | contact, admin account, `user_identities`, org `active` | contact, user row `active` with Signals org id and slug |
| Keycloak | enabled, `emailVerified=false`, `decision_made=approved`, `org_owner` role, org group | enabled, `emailVerified=false`, `decision_made=approved`, `aggregator_id`, `aggregator_type`, `signalstack_org_id`, roles |
| Signals | — | aggregator org (`external_id` = user id) |
| Not written | terms record, emails | terms record, invite, emails |

- `created_by` / `updated_by` and `decidedBy` read `provisioned:<operator>`, so loaded accounts can be found later.
- First sign-in with an email code works with no activation step. #1120 then shows the terms.

### Output

- **Report CSV**, one row per input row: kind, input row, name/email, outcome (`created`, `already_loaded`, `resumed`, `failed`), ids (org id, user id, Signals org id), error code.
- **Logs:** counts, ids and error codes only.

### Testing

- Unit tests for parsing, checks and tree ordering.
- Integration tests on the existing Testcontainers setup with fake Keycloak and Signals:
  - a three-level tree;
  - an owner who owns two orgs;
  - a rerun that skips everything;
  - a run stopped part-way then resumed;
  - a clash with an existing person.
- Assert that no consent row and no mail is created.
- The existing accept-route tests must pass unchanged after the refactor.
- Rehearsal on UAT before UP (runbook).

### Runbook

`docs/org-structure-loader-runbook.md`:
- sheet template per instance;
- copying files into the pod;
- `check`, then `apply`;
- reading the report;
- what to do with failures;
- cleaning up the files.

### Rules settled during review (author's calls)

**Mapping**
- The CSV `name` of a coordinator is the person, written to `contact.name`. The body's top-level `name` (the form's "Organisation Name") is set to the org's display name, as `CoordinatorRegisterForm` does.
- Coordinators can't be placed in the network facilitator root. `check` rejects it.

**Duplicates inside the files**
- Org names must be unique (case-insensitive). Coordinator person names may repeat.
- An owner may appear on several org rows only with the same email and phone. The contact id is built from both, so a different phone fails the insert.
- A person can't be both an owner and a coordinator in the files. The coordinator path refuses an owner's email.

**Reusing existing owners**
- An owner who already owns active orgs is reused: same contact, admin account and Keycloak user, looked up through the owner's existing org.
- An owner who has any pending (invited) org is refused. Approving a new org would stop their invited org from ever activating.
- The network admin (first `ADMIN_EMAILS`) and the Default-org owner are refused as owners of loaded orgs. The org store can't find them through `findByOwnerEmail`.

**Resuming**
- The loader only resumes or adopts rows it created (`created_by` / `updated_by` = `provisioned:%`). A real invitee's pending registration that matches a CSV row is a check error, never approved by the loader.
- A loader row left complete but pending is approved.
- A loader row left half-created by a killed process is removed and created again. Only the Keycloak user or group linked to it by id (`ownerKcSub`, `kcGroupId`, `aggregator_id`) is removed. The loader never adopts a Keycloak user or group found only by email or name; if one is in the way, that row fails and the report tells the operator.
- The owner's `decision_made` is set to `approved` only when owner access was fully granted, as activation does. A partial grant is repaired at the owner's first sign-in.
- Token roles: the approve services' background sync and the running API's sweep (`RBAC_TOKEN_ROLES_SWEEP_MS`) repair a deferred or failed sync. The loader still awaits one sync per account and reports a failure, but doesn't fail the row for it.

**Store changes**
- The org store's create input gets `createdBy` / `updatedBy`, which are hard-coded to `self` today.

## Left to the builder

- Exact names, CSV library choice (the repo already uses one in `profile-csv`) and report column order.
- How the "already loaded" comparison treats small differences (case, spaces, phone format): compare the normalised values.
- Whether the shared services take the stores as parameters or use the getters; follow `.claude/rules/base-class-pattern.md`.

## Open questions

None that change the design.
