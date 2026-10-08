# Runbook: the user & org release (Phases 1–5) on an existing instance

**Applies to:** every deployed instance at migration `0022_campaign_pii_audit`, moving to the release that carries the whole user & org train.
**Tool:** `node dist/tools/instance-upgrade.js` in the **release's own API image** (source `apps/api/src/tools/instance-upgrade.ts`).
**Design:** `docs/plans/user-org-migrate-tool-simplification.md`.

One window per environment, app down. One transaction applies every migration **and** runs every verify gate; it commits only when all gates are 0, so a failure always leaves the database where it was. The API refuses to apply this train at boot on a database with data — the instance only moves when you run `run`.

## 1. Before the window: prerequisites

- **The new release's ConfigMap and Secret are applied** (not yet the new Deployments). The tool runs with them: `DATABASE_URL`, `AGGREGATOR_NETWORK` (set it explicitly — the app has a default, the tool does not), `AGGREGATOR_BRAND`, `KEYCLOAK_*`.
- **`DATABASE_URL` points straight at Postgres**, not through PgBouncer or another transaction pooler (the run needs one session: its lock, settings and temporary objects). Never a read replica.
- **The role owns the tables** (the API's own role does) and may create temporary objects (`check` rows T0b / T0e).
- **PostgreSQL 14 or later** (T0d).
- **`ALLOW_TRAIN_ON_BOOT` is unset or `false`** in every deployment values file. It is a dev / e2e switch: `true` lets an API pod apply the train at boot, unsupervised, skipping every check here.
- **Free disk / WAL at least the database size** (`check` row F12b, in MB): the whole train is one transaction.
- **Everything else that connects is identified**: GitOps auto-sync (Argo CD / Flux) and CronJobs that would restart pods, BI / reporting tools, a DBA's session. The run refuses while any is connected, and rolls back if one connects while it runs.
- **Replication and scheduling** (`check` row F23 — publications, replication slots, subscriptions, pg_cron jobs): review; the train renames tables.
- **The Keycloak portal gate admits org owners** (Phase 5). Local / compose realms are rebuilt by the `keycloak-init` sidecar at boot (`apply-portal-gate.py`: an older gate fails its check and is replaced). The **deployment realm** lives in bluedots-automation: confirm the same gate change is applied there (or run `apply-portal-gate.py` against it) before the window — without it, owners are refused at sign-in with "this account can't be used to sign in here".
- **The realm's SMTP is configured** (Realm settings → Email). Owners of the root and the Default org usually have no phone, so their one-time code goes by email **through Keycloak's own SMTP**, not the API's mailer.
- **The first `ADMIN_EMAILS` address (the network admin) and `DEFAULT_ORG_OWNER_EMAIL` are not a coordinator's address**, and `DEFAULT_ORG_OWNER_EMAIL` does not own another organisation: one login is one account, so the boot reconcile refuses such a config (logged) and keeps the current owner.

## 2. Running the tool

Run each step as a **Job** (not `kubectl run --rm -it`: a lost terminal would delete the pod and the output, which is the change record):

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: user-org-train-<step>
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: train
          image: ghcr.io/<org>/aggregator-dpg/api:<release tag>
          command: ['node', 'dist/tools/instance-upgrade.js', 'check'] # the step
          envFrom:
            - configMapRef: { name: <api configmap> }
            - secretRef: { name: <api secret> }
```

`kubectl apply -f job.yaml && kubectl logs -f job/user-org-train-<step>`; keep each Job's log with the change record.

| Command                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                             | Exit  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `check`                                                   | Read-only. At **0022**: drain (D1–D6), prerequisites and pre-flight (T0b–F23), Keycloak prerequisite (F19). Part-way through the train (a rehearsal copy): what `run` will apply. At **the latest level**: every verify gate, plus `I1` (coordinators without a recorded login). Prints `MIGRATION IN PROGRESS` when a run holds the lock. Below 0022: refused.                                          | 0 / 1 |
| `check --fix <name> [--id / --org-id <uuid>] [--dry-run]` | A documented fix (§5) in one transaction; `--dry-run` rolls back.                                                                                                                                                                                                                                                                                                                                        | 0 / 1 |
| `run --dry-run`                                           | Everything `run` does, then **always rolls back**.                                                                                                                                                                                                                                                                                                                                                       | 0 / 1 |
| `run --snapshot-taken <id>`                               | The pending migrations and every gate; **commits** only when all pass and no other session connected meanwhile.                                                                                                                                                                                                                                                                                          | 0 / 1 |
| `enrich [--dry-run] [--rate <n/s>]`                       | After the train only. Records each coordinator's Keycloak login and backfills org-owner names. Resumable. **Its exit code is a gate.** Lists coordinators with no Keycloak user and login conflicts, by id.                                                                                                                                                                                              | 0 / 1 |
| `enable-owners [--dry-run] [--rate <n/s>]`                | After `enrich`, once. Lets the owner of every active organisation sign in: enables their Keycloak user, grants `org_owner`, adds the org's group (also repairs a missing role / group). Resumable and idempotent. Lists by org id owners with no recorded login or a deleted Keycloak user. Exit 1 on a Keycloak error (re-run). The Default org's and the root's owners are handled by the API at boot. | 0 / 1 |

Output is counts, check ids, error codes and database ids — never an email, phone or name.

## 3. The window

| When        | Step                                                                                                                                                                                                                                                                                                                                                                                   | Done when                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **T−7**     | Restore the environment's latest snapshot into a staging database. Against it: `check`, `run --dry-run`, `run --snapshot-taken staging`, `enrich --dry-run`, `enable-owners --dry-run`; start the new images on staging and run the **full** smoke test (writes included). Note how long `run` took. Against the **real** environment: `check`, and clear pre-flight blockers with §5. | staging green; real `check` shows only D1–D5 |
| **T−1**     | `check` on the real environment. Apply the new ConfigMap / Secret (§1). Announce the window.                                                                                                                                                                                                                                                                                           | only D1–D5 left                              |
| **T0 − 2h** | Announce the freeze: no new registrations, uploads or campaigns. Approve / reject pending coordinators (D1) and orgs (D2); let uploads (D3) and campaigns (D4) finish; revoke or use pending invites (D5); `check --fix expire-stale-presigns` (D6).                                                                                                                                   | `check`: D1–D5 = 0                           |
| **T0**      | Pause GitOps auto-sync and CronJobs. Scale the **API and worker to 0**; web shows maintenance.                                                                                                                                                                                                                                                                                         | `check` shows `other_sessions=0`             |
|             | Take the database snapshot; note its id.                                                                                                                                                                                                                                                                                                                                               | available                                    |
|             | `run --snapshot-taken <id>`                                                                                                                                                                                                                                                                                                                                                            | `COMMITTED`                                  |
|             | `enrich`                                                                                                                                                                                                                                                                                                                                                                               | exit 0 (or §4's rule)                        |
|             | `enable-owners`                                                                                                                                                                                                                                                                                                                                                                        | exit 0                                       |
|             | `ANALYZE` (the planner has no statistics for the new tables yet). Deploy the new API, worker and web images (boot finds nothing pending).                                                                                                                                                                                                                                              | ready                                        |
|             | `check` (latest level) and **read-only** smoke checks: coordinator OTP login, dashboard, profile (org details), an approval link opening, an **org owner** signing in and seeing the console with their organisation, and the **network admin** signing in and seeing the network view.                                                                                                | all green — **go / no-go**                   |
|             | Scale up; resume GitOps; end the window. Then the write smoke checks with a named test org: a public link submit, a bulk upload, a registration with the org selector, an approval from the console.                                                                                                                                                                                   |                                              |

Why read-only before go / no-go: a submit, upload, registration or approval creates Keycloak users, Signals participants, S3 objects, queue jobs and emails that a snapshot restore does not undo.

**Downtime** ≈ the snapshot + the staging `run` time + `enrich` (paced, 5 coordinators / s by default) + `enable-owners` (paced, 5 owners / s) + pod start.

## 4. When something fails

- **`RUN FAILED … nothing was applied`** — a migration error (`P0001` messages are printed in full), a verify gate or count that is not equal, or a session that connected during the run: the database is unchanged. Scale the old images back up and end the window; reproduce with `run --dry-run` on staging. A migration message that names `users-preflight.sql`, `organisation-preflight.sql` or `cleanup-preflight.sql` (deleted) means: run `check` — the same finding is in `instance-upgrade-check.sql`.
- **`REFUSED: …`** — nothing was changed; the message names what is missing: snapshot id, network, sessions still connected, the wrong level, a pooler that dropped the session settings, or `N blocker(s)` (the rows above it say which).
- **`RUN FAILED (55P03)`** — the migration lock or a table lock was not free within 10 s: something still holds it (a boot pod, an orphaned run). `check` says `MIGRATION IN PROGRESS` while a run holds the lock.
- **The Job died or the log stopped mid-run** — do not guess. Run `check`: `MIGRATION IN PROGRESS` → wait and `check` again; `state=done` → the train is applied, continue with `enrich`; `state=start` → nothing was applied.
- **`COMMIT reported an error, but the train IS applied`** → continue with `enrich`. **`the level cannot be read`** → `check` until it answers before scaling anything.
- **`enrich` exits 1** — re-run it; it resumes. If it still fails: **Keycloak unreachable** → wait up to the window's agreed limit, then decide with the product owner; **login conflicts** (listed by id) → those coordinators' logins are recorded at their next sign-in; going ahead is acceptable when only conflicts remain. Note the ids in the change record.
- **`enable-owners` exits 1** — re-run it; it resumes. Owners listed as "no recorded login" or "keycloak user missing" cannot sign in yet: going ahead is acceptable; note the org ids and fix them after the window (the network admin's console "repair access" re-runs the grant once the login exists).
- **An owner cannot sign in after the window** — their organisation's access: "repair access" in the network admin's console. The whole realm refuses owners ("this account can't be used to sign in here … its sign-in may not be enabled yet"): the deployment realm's gate was not updated (§1).
- **Rollback before scale-up:** restore the snapshot and redeploy the previous tag (and the previous ConfigMap / Secret). **After scale-up:** fix forward — there is no revert.

## 5. Reading `check`, and the fixes

Rows are `check_id`, `category`, `n`. A `blocker` (or a verify `gate`) above 0 stops `run`; `info` is for the change record.

| Check                                                                          | Category     | Action                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 `coordinators_pending` / D2 `orgs_pending`                                  | blocker      | Approve or reject in the app before T0. A never-approved duplicate can go: `check --fix retire-registration --id <id>` (it leaves the disabled Keycloak user — delete it by hand, or the phone stays taken). |
| D3 `bulk_uploads_in_flight` / D4 `campaign_jobs_in_flight`                     | blocker      | Let them finish; the watchdogs fail stuck ones.                                                                                                                                                              |
| D5 `invites_pending`                                                           | blocker      | Revoke them (owners re-invite after the window) or let them be used. Expired ones are not counted.                                                                                                           |
| D6 `bulk_presigns_never_uploaded`                                              | info         | `check --fix expire-stale-presigns` marks them `failed`.                                                                                                                                                     |
| T0d `server_older_than_14` / T0e `no_temp_privilege`                           | blocker      | Upgrade Postgres / grant `TEMP` on the database to the role.                                                                                                                                                 |
| T0b `role_cannot_act_as_owner` / T0c `names_taken`                             | blocker      | Use the table owner's role / find and drop the stray object.                                                                                                                                                 |
| F1 / F2 (contact pairs, phone format, blank email)                             | blocker      | Correct the contact by hand, or retire a never-approved duplicate.                                                                                                                                           |
| F4 `rename_target_taken`                                                       | blocker      | Rename one of the orgs by hand first.                                                                                                                                                                        |
| F8 / F10b / F10c / F10d / F16 / F16b / F22                                     | blocker      | Investigate (they are expected 0); see the comment above each check in `scripts/sql/instance-upgrade-check.sql`. F16b: objects in other schemas (views, foreign keys, functions) on the renamed tables.      |
| F10 `backfill_network_unknown`                                                 | blocker      | Run the tool with the API's config (`AGGREGATOR_NETWORK`).                                                                                                                                                   |
| F15 / F15b (owner Keycloak subjects)                                           | blocker      | `check --fix choose-owner-subject --org-id <the live org>`; F15b needs a human.                                                                                                                              |
| F3, F4 renames, F5, F6, F7, F10 backfilled, F11, F12, F12b, F13, F14, F18, F23 | info         | Tell the coordinators counted by F13 that they will see their org's url / locations / company / GST; tell owners renamed by F4; size the disk by F12b; review F23.                                           |
| F19 (Keycloak)                                                                 | `check` only | `aggregator-api` needs `manage-realm` + `manage-users`, and the realm role `org_owner` must exist.                                                                                                           |
