# Runbook: loading the org structure of a new instance

**Applies to:** a new instance on the `hotfix/up-speedrun` side branch (UP first), before any real person logs in.
**Tool:** `node dist/tools/org-loader.js` in the instance's **own API image**, run inside a running API pod through `kubectl exec -i` (source `apps/api/src/tools/org-loader.ts`).
**Design:** `docs/superpowers/specs/2026-11-19-org-structure-loader-design.md` (issue #1118).

The loader creates the orgs, their owners and their coordinators that product sends, through the same create and approve code as the invite path, with everyone already approved. It sends **no email** and records **no terms acceptance**: people accept the terms at their first login (#1120). Every row it creates carries `created_by = provisioned:<operator>`.

Rehearse the whole runbook on UAT before UP.

## 1. Rules before you start

- **Nobody is told to log in until the terms screen (#1120) is live on the instance.** A provisioned account has accepted nothing; without the terms screen it would sign in without ever seeing the terms.
- The CSV files hold names, emails and phones. They stay on your machine: the tool reads them from stdin and writes the report to stdout, so **no file is ever written in the pod**. Never paste rows into a ticket or chat.
- The reports hold names and emails too. Treat them like the input files, and delete all of them after handing the results over (§7).
- `kubectl exec` stdout and stderr go only to your terminal. They do not reach the pod's logs. The tool's own log lines (ids, counts and error codes) go to stderr.
- The tool needs the API's full environment (database, Keycloak, Signals, Redis), so it runs only in an **API pod**. Name the container explicitly with `-c api` (adjust if the deployment names it differently). Every command below is run exactly this way; the UAT rehearsal must use the same commands.
- `--operator` is your own short name (no spaces, no `:`), for example `--operator aniket`. It is written as `provisioned:<operator>` on every row the run creates, so loaded accounts can be found later.

## 2. The sheet template

Each instance has its own org form (`org-registration.v1.json`) and coordinator form (`registration.v1.json`), so the columns differ. Get the headers from the instance itself:

```sh
kubectl -n <ns> get pods -l app.kubernetes.io/name=<api>        # pick one running API pod
kubectl -n <ns> exec <api-pod> -c api -- node dist/tools/org-loader.js template --kind orgs > orgs-header.csv
kubectl -n <ns> exec <api-pod> -c api -- node dist/tools/org-loader.js template --kind coordinators > coordinators-header.csv
```

`template` prints one header line: the fixed columns, then every field of the instance's form except the fixed keys and `consent`. Share the two headers with product as a Google Sheet (one tab per file); export each tab as CSV when it comes back.

Headers today (check against `template`; it is the source of truth):

| Instance                   | `orgs.csv`                                                                                                                                                                                                                                                                                                                          | `coordinators.csv`                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `blue_dot` / `up-gzb` (UP) | `name,parent,owner_name,owner_phone,owner_email,website,gst_number,aggregator_type,organisation_type,organisation_sub_type_educational,organisation_sub_type_non_educational,management_type,address_streetAddress,address_addressLocality,address_addressDistrict,address_addressRegion,address_postalCode,address_addressCountry` | `org,name,phone,email,profile_types,sub_org_name,url` |
| `blue_dot` / `ka-dhwd`     | same as UP                                                                                                                                                                                                                                                                                                                          | same as UP                                            |
| `purple_dot` / `alimco`    | `name,parent,owner_name,owner_phone,owner_email,website,gst_number,aggregator_type,organisation_type,address_*` (six address columns as above)                                                                                                                                                                                      | `org,name,phone,email,profile_types,sub_org_name,url` |
| shared default (no brand)  | `name,parent,owner_name,owner_phone,owner_email,website,gst_number,domains,address_*`                                                                                                                                                                                                                                               | `org,name,phone,email,profile_types,url`              |

How to fill them in:

- **`orgs.csv`**, one row per org, any order. `name` is the org's display name, unique (case-insensitive). `parent` is the name of the parent org, from this file or already on the instance; blank means directly under the network facilitator. `owner_name`, `owner_phone`, `owner_email` are required. One owner may own several orgs: repeat the same name, email and phone on each row. Fields the form requires (UP: `aggregator_type`, `organisation_type`, `management_type`) are required here too, with the form's values. A list field (for example `aggregator_type`, `domains`) takes several values separated by `;`.
- **`coordinators.csv`**, one row per coordinator. `org` is the org's name, from `orgs.csv` or already on the instance (not the network facilitator). `name` is the person. `profile_types` is required: one or more of the network's domain ids (for example `seeker;provider`), separated by `;`.
- Phones may be written as 10 digits or with `+91`. One email and one phone belong to one person across owners and coordinators; a person cannot be both an owner and a coordinator.
- Either file may be left out, for example coordinators for orgs that already exist.

## 3. Order of the runs

Orgs and coordinators are loaded in two separate runs, because only one input can come through stdin per run, and coordinators need their orgs to exist:

1. `check` the orgs, fix, repeat until it passes (§4).
2. `apply` the orgs (§5).
3. Then `check` the coordinators. A coordinator's `org` must be an org on the instance by now, so this check fails with `UNKNOWN_ORG` if it runs before step 2.
4. `apply` the coordinators.

A load with only coordinators (for orgs that already exist) skips steps 1 and 2.

## 4. `check`

```sh
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/org-loader.js check --orgs - < orgs.csv
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/org-loader.js check --coordinators - < coordinators.csv   # after the orgs are applied
```

`-i` is required: without it the pod never sees your file on stdin.

`check` reads the database and Keycloak and writes nothing. It prints every problem as `<input>:<line> <code> [<field>]`, for example `orgs(stdin):3 INVALID_PHONE owner_phone` (line 1 is the header, the first data row is line 2), then how many orgs and coordinators would be created, resumed or skipped, then `CHECK PASSED` (exit 0) or `CHECK FAILED` (exit 1). It never prints row data.

| Code                                            | Meaning and fix                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_COLUMN`, `REQUIRED`, `MALFORMED_ROW`   | A header column, a required cell, or the row's CSV shape is wrong. Fix the sheet.                                                              |
| `SCHEMA_VALIDATION`, `INVALID_PHONE`            | The named field fails the instance's form (wrong value, bad format). Fix the cell.                                                             |
| `DUPLICATE_ORG_NAME`, `DUPLICATE_COORDINATOR`   | The same org name, or the same coordinator email or phone, appears twice.                                                                      |
| `OWNER_CONTACT_MISMATCH`                        | One owner email appears with different names or phones.                                                                                        |
| `OWNER_IS_COORDINATOR`                          | One person is listed as both an owner and a coordinator.                                                                                       |
| `UNKNOWN_PARENT`, `UNKNOWN_ORG`, `PARENT_CYCLE` | A `parent` / `org` name matches nothing, or parents form a loop.                                                                               |
| `PARENT_BLOCKED`, `ORG_BLOCKED`                 | The row's parent or org has its own problem. Fix that row first.                                                                               |
| `COORDINATOR_IN_ROOT`                           | Coordinators cannot sit directly in the network facilitator. Give them an org.                                                                 |
| `TREE_LIMIT`                                    | The tree would break the instance's depth, children or total-org limit (`aggregator.organisation.hierarchy`). Ask product to reshape the tree. |
| `ORG_EXISTS_OTHER_OWNER`                        | The org name exists on the instance with another owner.                                                                                        |
| `CONTACT_TAKEN`, `COORDINATOR_EXISTS_ELSEWHERE` | The email or phone already belongs to another person or another org on the instance.                                                           |
| `OWNER_HAS_PENDING_ORG`, `OWNER_RESERVED`       | The owner has an invited org still pending, or is the network admin or the Default-org owner. Use another owner.                               |
| `OWNER_LOGIN_MISSING`                           | The existing owner's Keycloak user is gone. Repair the owner first (`POST /v1/org/access/repair/:id`).                                         |
| `NOT_PROVISIONED_PENDING`                       | A real invitee's pending registration matches the row. The loader never adopts it; talk to product.                                            |
| `CHECK_FAILED`                                  | A check threw (for example an unreadable schema). Look at the log line for the row.                                                            |

`PLAN FAILED: PLAN_LOOKUP_FAILED (<operation>)` means a database or Keycloak lookup failed; nothing was written. Fix the connection and run `check` again.

Repeat until `CHECK PASSED`.

## 5. `apply`

```sh
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/org-loader.js apply \
  --orgs - --operator <your name> --report - < orgs.csv > orgs-report.csv

# only after the orgs apply exits 0, and the coordinators check passes:
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/org-loader.js apply \
  --coordinators - --operator <your name> --report - < coordinators.csv > coordinators-report.csv
```

With `--report -` the report CSV is the only thing on stdout, so `> orgs-report.csv` captures it on your machine; the progress lines, problems and counts appear on your terminal through stderr.

- `apply` runs every check of `check` first and **refuses to start** on any problem (exit 1, nothing written).
- It then creates the orgs (parents first), approves each one, then creates and approves the coordinators. It **stops at the first failed row**.
- Always use `--report -` in the pod. Given a path instead, the tool writes the report there (default: `org-loader-report-<time>.csv` in the temp directory), which is for local runs only.
- It loads the RBAC runtime first, so each account's token roles are synced and the outcome recorded. A failed or deferred sync never fails the row; the API's background sweep repairs it.
- Exit codes: 0 every row loaded, 1 refused or a row failed, 2 usage.

Check the exit code (`echo $?`) and the last stderr line before the next run.

## 6. Reading the report, fixing failures, rerunning

The report has one row per input row, orgs first (parents first), then coordinators:

| Column         | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | `org` or `coordinator`                                                                                                            |
| `line`         | The row's line in its input file                                                                                                  |
| `name`         | Org name (org rows) or the coordinator's name                                                                                     |
| `email`        | Owner email (org rows) or the coordinator's email                                                                                 |
| `outcome`      | `created`, `resumed` (a row an earlier run left pending or half-created), `already_loaded`, `failed`, `not_run` (after a failure) |
| `orgId`        | The org's id                                                                                                                      |
| `userId`       | The owner's or the coordinator's account id                                                                                       |
| `signalsOrgId` | The coordinator's Signals org id                                                                                                  |
| `rolesSync`    | Token-roles sync: `synced`, `off` (RBAC off), `no_login`, `deferred`, `failed`                                                    |
| `errorCode`    | Why the row failed                                                                                                                |

On a failure the command prints `APPLY FAILED at <file>:<line> <code>`. Common codes:

- `IDP_UNAVAILABLE`, `SIGNALSTACK_UNAVAILABLE`, `DB_UNAVAILABLE`: Keycloak, Signals or the database failed. Fix it and rerun.
- A Keycloak user or group already in the way (for example `USER_EXISTS`): the loader never adopts a Keycloak user or group found only by email or name. Look at it in the Keycloak admin console and remove it if it is a leftover, then rerun.
- `ORG_INACTIVE`, `NO_PROFILE_TYPES`, `NOT_PROVISIONED`: the row on the instance is not one the loader can finish. Talk to the team before touching it.
- `UNEXPECTED`: a step threw; the log line for the row has the error type.

**Rerunning is safe.** Run `check` and `apply` again with the **same file** (and a new local report name, for example `orgs-report-2.csv`). Rows already loaded are `already_loaded` and skipped; a row left pending by the stopped run is approved (`resumed`); a row left half-created (no Keycloak user or group) is removed and created again (`resumed`). Only the Keycloak user or group linked to that row by id is removed.

`rolesSync` other than `synced` / `off` needs no action: the sweep repairs it within `RBAC_TOKEN_ROLES_SWEEP_MS`.

## 7. Delete the files

Nothing was written in the pod. On your machine, once the results are handed over (the reports to whoever keeps the instance's personal data, the counts to the ticket), delete the input CSVs and every report:

```sh
rm orgs.csv coordinators.csv orgs-report*.csv coordinators-report*.csv
```

## 8. After the load

- Confirm the tree in the console as the network admin.
- **Nobody is told to log in until the terms screen (#1120) is live.** At first sign-in with an email code the account works with no activation step, and #1120 then shows the terms and records the acceptance (`source = 'first-login'`).
- QR links (#1119) and bulk uploads (#1124) per coordinator come next.

## 9. Returning to the main release cycle

The loader and its consent rule live only on the `hotfix/up-speedrun` side branch. The main release cycle does not know about the following, so the operations team reconciles them before moving UP back:

1. **Provisioned accounts that haven't logged in yet.**
   - The main release has no terms screen at login, so these people would never see the terms.
   - The main release's `coordinator_without_consent` check fails on them, which blocks the instance-upgrade tool.
   - Before switching back, either wait until all of them have logged in, or carry the consent rule and the terms screen into the main release.
   - This read-only query counts them (0 means none is left):

     ```sql
     SELECT count(*) FROM users u WHERE u.created_by LIKE 'provisioned:%' AND NOT EXISTS (SELECT 1 FROM consent_record c WHERE c.user_id = u.id AND c.source = 'first-login')
     ```

2. **`source = 'first-login'` acceptances.** The main release's check doesn't count this source either, so it needs the same carry-over or a check fix.
3. **The `provisioned:<operator>` marker** on `created_by` / `updated_by` is plain data and needs nothing.
4. The side branch is then closed.
