# Runbook: loading QR registration links for coordinators

**Applies to:** a new instance on the `hotfix/up-speedrun` side branch (UP first), after the org structure is loaded.
**Tool:** `node dist/tools/qr-links.js` in the instance's **own API image**, run inside a running API pod through `kubectl exec -i` (source `apps/api/src/tools/qr-links.ts`). The images come from `apps/api/scripts/qr-images.ts`, run on your own machine.
**Design:** `docs/superpowers/specs/2026-11-20-qr-links-loader-design.md` (issue #1119).

The tool creates one two-option registration link per sheet row, owned by that coordinator, through the same create code as the portal's links page. A "two-option" link asks the person to choose between a voice call and the web form. Product receives one QR image per link.

Rehearse the whole runbook on UAT before UP.

## 1. Rules before you start

- **Prerequisites.** The instance runs the #1122 two-option config, with its voice bots configured (`registration_modes` on the network and `AGGREGATOR_ONBOARDING_ENABLED`). Every coordinator in the sheet is already loaded (org-structure runbook) and **active**.
- The sheet holds coordinator emails. It stays on your machine: the tool reads it from stdin and writes the report to stdout, so **no file is ever written in the pod**. Never paste rows into a ticket or chat.
- The report holds emails too, and the QR images show each link. Treat them all like the sheet, and delete them after handing the images over (§6).
- `kubectl exec` stdout and stderr go only to your terminal. The tool's own log lines (ids, counts and error codes) go to stderr.
- The tool needs the API's full environment, so it runs only in an **API pod**. Name the container with `-c api` (adjust if the deployment names it differently). The UAT rehearsal must use the same commands.
- `--operator` is your own short name (no spaces, no `:`), for example `--operator aniket`. It appears in the logs and the report run, as `provisioned:<operator>`. The link itself belongs to the coordinator.

## 2. The sheet template

One row per link. Share this header with product as a Google Sheet; export it as CSV when it comes back (save as `links.csv`):

```
coordinator_email,profile_type,voice_bot,link_name,expires_on
```

| Column              | Required | Meaning                                                                                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinator_email` | yes      | The coordinator who owns the link. Must be loaded and active.                                                                                |
| `profile_type`      | yes      | One of the network's domain ids that coordinator serves, for example `seeker`.                                                               |
| `voice_bot`         | no       | The voice bot's key. Leave blank to use the domain's only or default bot. Required when the domain has several bots and none is the default. |
| `link_name`         | no       | The link's name in the web address (lowercase letters, digits and single hyphens, 3 to 60 characters). Blank gets a random name.             |
| `expires_on`        | no       | Last day the link works, as `YYYY-MM-DD`; the whole day counts, in UTC. Blank means no expiry.                                               |

Keep the headers exactly as above. Any other column fails with `UNKNOWN_COLUMN` (line 1), because its values would otherwise be dropped without a word.

## 3. `check`

```sh
kubectl -n <ns> get pods -l app.kubernetes.io/name=<api>        # pick one running API pod
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/qr-links.js check --links - --operator <your name> < links.csv
```

`-i` is required: without it the pod never sees your file on stdin. `--links` must be `-` (stdin is the only source).

`check` reads the database and writes nothing. It prints every problem as `<line> <code> [<field>]`, for example `3 UNKNOWN_VOICE_BOT voice_bot` (line 1 is the header, the first data row is line 2), then how many links would be created or are already loaded, then `CHECK PASSED` (exit 0) or `CHECK FAILED` (exit 1). It never prints row data.

| Code                                          | Meaning and fix                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_COLUMN`, `REQUIRED`, `MALFORMED_ROW` | A header column, a required cell, or the row's CSV shape is wrong. Fix the sheet.                                               |
| `UNKNOWN_COLUMN`                              | A header (named, line 1) is not a template column, for example a typo. Rename or remove it.                                     |
| `UNKNOWN_COORDINATOR`                         | No coordinator has that email. Load the coordinator first, or fix the email.                                                    |
| `COORDINATOR_NOT_ACTIVE`                      | The coordinator is loaded but not active. Finish the coordinator load first.                                                    |
| `NO_SIGNALS_ORG`                              | The coordinator has no Signals org yet. Talk to the team; the coordinator load did not finish.                                  |
| `DOMAIN_NOT_SERVED`                           | The coordinator does not serve this `profile_type`. Fix the cell or the coordinator's types.                                    |
| `UNKNOWN_VOICE_BOT`                           | `voice_bot` is not a bot key on this instance.                                                                                  |
| `VOICE_BOT_NOT_FOR_DOMAIN`                    | The bot exists but does not serve this `profile_type`.                                                                          |
| `VOICE_BOT_REQUIRED`                          | The domain has several bots and no default. Fill in `voice_bot`.                                                                |
| `INVALID_LINK_NAME`                           | `link_name` is not 3 to 60 characters of lowercase letters, digits and single hyphens.                                          |
| `LINK_NAME_TAKEN`                             | See the rerun rules (§5). Change `link_name` in the sheet.                                                                      |
| `INVALID_EXPIRY`, `EXPIRY_IN_PAST`            | `expires_on` is not a real `YYYY-MM-DD` date, or is already over.                                                               |
| `DUPLICATE_ROW`                               | The same coordinator, profile type and `link_name` as an earlier row.                                                           |
| `MODE_NOT_ENABLED`                            | The network declares no two-option mode, or this deployment does not enable it. Fix the instance config (#1122) before loading. |
| `CHECK_FAILED`                                | A lookup failed or a check threw. Look at the log line for the row.                                                             |

Repeat until `CHECK PASSED`.

## 4. `apply`

```sh
kubectl -n <ns> exec -i <api-pod> -c api -- node dist/tools/qr-links.js apply \
  --links - --operator <your name> < links.csv > links-report.csv
```

The report goes to stdout and is the only thing on stdout, so `> links-report.csv` captures it on your machine; progress lines, problems and counts appear on your terminal through stderr.

- `apply` runs every check of `check` first and **refuses to start** on any problem (exit 1, nothing written).
- It then creates the links in sheet order and **stops at the first failed row**; later rows are `not_run`.
- Exit codes: `0` every row loaded; `1` refused, or a row failed, or an unexpected error; `2` usage (an unknown flag or command, `--links` not `-`, `--operator` missing on `apply`, a bad operator name, or no redirected stdin).

Check the exit code (`echo $?`) and the last stderr line (`APPLY COMPLETE` or `APPLY FAILED at line <n> <code>`) before the next step.

The report has one row per sheet row, in sheet order:

| Column              | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `line`              | The row's line in the sheet                                                                 |
| `coordinator_email` | The coordinator                                                                             |
| `profile_type`      | The row's profile type                                                                      |
| `voice_bot`         | The bot stored on the link; empty when no bot serves the profile type                       |
| `slug`              | The link's name in its address; empty unless the row is `created` or `already_loaded`       |
| `url`               | The public address, what the QR image holds; empty unless `created` or `already_loaded`     |
| `outcome`           | `created`, `already_loaded` (an earlier run made it), `failed`, `not_run` (after a failure) |
| `error_code`        | Why a `failed` row failed                                                                   |

A cell that starts with `=`, `+`, `-` or `@` has a leading `'` added so a spreadsheet does not read it as a formula. The image script removes it again.

Failure codes on a row:

| Code                                                                                                             | Meaning and fix                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DB_UNAVAILABLE`                                                                                                 | The database failed. Fix it and rerun.                                                                        |
| `DUPLICATE_SLUG`                                                                                                 | The name was taken by another link between `check` and `apply`. Change `link_name` and rerun.                 |
| `CALL_TIMEOUT`                                                                                                   | The create call did not finish in time. The link may exist; a rerun finds it (`already_loaded`).              |
| `UNEXPECTED`                                                                                                     | A step threw; the log line for the row has the error type.                                                    |
| `SCHEMA_VALIDATION`, `DOMAIN_NOT_SERVED`, `INVALID_REGISTRATION_MODE`, `INVALID_VOICE_BOT`, `VOICE_BOT_REQUIRED` | The create rules refused what `check` accepted. Talk to the team; the config may have changed during the run. |

## 5. Rerun rules

**Rerunning is safe.** Run `check` and `apply` again with the **same sheet** (and a new local report name, for example `links-report-2.csv`). A row whose link is already there is `already_loaded` and creates nothing; the rest are created.

- A row is already loaded when that coordinator has a **live two-option link of the same profile type with the same `link_name`**.
- With **no** `link_name`, every run creates a new random-named link. Give every row a `link_name` if you may need to rerun.
- `LINK_NAME_TAKEN`: the coordinator already uses that name, and the existing link is not the same live two-option link of the same profile type (it is another profile type or mode, expired, or no longer live). It is refused, never replaced. **Fix: change `link_name` in the sheet.**
- Because `apply` stops at the first failure, fix the cause and rerun the whole sheet; the rows already created are skipped.

## 6. Make the QR images (on your machine)

Run from a checkout of this repository (the API image has no `tsx`), with dependencies installed:

```sh
pnpm --filter @aggregator-dpg/api exec tsx scripts/qr-images.ts --in links-report.csv --out qr-images
```

- It writes one PNG per `created` or `already_loaded` row, named `<email part before @>-<profile_type>-<slug>.png` in lowercase, with every other character turned into `-`. The images use the same settings as the portal's QR dialog, so they scan the same way.
- `failed` and `not_run` rows get no image.
- It refuses an `--out` folder that already has files in it. Use a new folder, or add `--force`.
- It needs no network access and no instance settings.

## 7. Hand over and delete

Give product the `qr-images` folder and the report (the report maps each image to its coordinator, voice bot and address). Share them the way product already receives personal data; never in a ticket or chat. Once handed over, delete everything on your machine:

```sh
rm -r links.csv links-report*.csv qr-images
```

Nothing was written in the pod.
