# Bulk upload on a coordinator's behalf: runbook

Our team uses this command to run a bulk upload of seekers or providers for a coordinator who has not signed in yet. It goes through the same pipeline as a portal upload: the same storage, attestation, processing job, row checks and errors report. The upload then appears on that coordinator's Onboarding page and My Blue Dots like any other.

The command ships in the API image (`dist/tools/bulk-upload.js`) and runs in the API pod. The image has no shell or `tar`, so `kubectl cp` does not work: the CSV goes in on stdin and the errors report comes out on stdout. `--file` takes only `-`; any other value is a usage error (exit code 2). Messages and logs go to stderr, so they show in the terminal but never in a file you save from stdout.

## Before you start

- **Not on UP until product and legal confirm** that our team can attest, as operator, that the source team holds the participants' consent.
- The coordinator must be **active** (loaded by the org loader or registered normally) and must serve the profile type you upload.
- The CSV is built from the coordinator's bulk-upload template for that profile type and is at most `BULK_UPLOAD_MAX_BYTES` (the same limit as the portal).
- `--operator` is your team's name, with no spaces or `:`, for example `ops-team`. It is recorded in the logs of the run.

```bash
NS=<aggregator namespace>
API=deploy/<release>-api          # the API deployment; the container is `api`
```

## Run an upload

```bash
kubectl -n "$NS" exec -i "$API" -c api -- \
  node dist/tools/bulk-upload.js \
    --coordinator <coordinator email or user id> \
    --type seeker \
    --file - \
    --operator ops-team \
  < seekers.csv
```

The command checks the coordinator, the file size and the header before it creates anything. It then starts the upload and waits for processing (up to an hour), printing each status change and, when rows failed, how to fetch the errors report:

```
upload 3f6c…e1 created
upload 3f6c…e1 started
  row_processing…
status: completed
rows: 120 total, 117 passed, 3 failed, 0 skipped
errors report: --upload-id 3f6c…e1 --errors-csv > errors.csv
WARNING: 3 rows failed
```

Note the upload id; it is printed as soon as the upload is created, so it is there even if a later step fails. Exit codes:

| Code | Meaning                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0    | The upload completed and no row failed.                                                                                       |
| 1    | Refused, failed, or still processing.                                                                                         |
| 2    | The arguments were wrong.                                                                                                     |
| 3    | The upload completed with failed rows (or no row counts were recorded); it prints a `WARNING:` line. Fetch the errors report. |

### Rate limit

The usual per-coordinator limit (5 uploads an hour) applies. For the initial load only, add `--skip-rate-limit`; the command logs that the limit was skipped.

## Get the errors report

When some rows failed, fetch the report (it holds participant data, so delete it once the rows are fixed):

```bash
kubectl -n "$NS" exec "$API" -c api -- \
  node dist/tools/bulk-upload.js --coordinator <coordinator> --upload-id <upload id> --errors-csv \
  > errors.csv
```

Fix the failed rows and upload them as a new file.

## If the terminal drops or the wait runs out

The upload carries on in the worker. Read its result later:

```bash
kubectl -n "$NS" exec "$API" -c api -- \
  node dist/tools/bulk-upload.js --coordinator <coordinator> --upload-id <upload id>
```

Run the upload again only when this reports `failed`, `file_failed`, or `upload … never started; it is safe to run the upload again` (the run stopped before the start, so nothing is processing). In every other case the upload is processing or done, and a second run creates a second upload.

## What the messages mean

| Message                                                           | Meaning                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFUSED: no coordinator with that email or user id`              | Check the address or id.                                                                                                                      |
| `REFUSED: coordinator … is pending, not active`                   | The coordinator has not been approved yet.                                                                                                    |
| `REFUSED: coordinator … has no recorded Keycloak login`           | The coordinator was never approved through the normal approval step.                                                                          |
| `REFUSED: coordinator … has no Signals org`                       | The coordinator's approval did not finish; every row would fail.                                                                              |
| `REFUSED: DOMAIN_NOT_SERVED: …`                                   | Wrong `--type`, or the coordinator does not serve it.                                                                                         |
| `REFUSED: missing columns: …` / `unknown columns: …`              | The CSV header does not match the template; nothing was created.                                                                              |
| `REFUSED: the file is not valid UTF-8`                            | Save the CSV as UTF-8 and run it again; nothing was created.                                                                                  |
| `REFUSED: rate limited; retry in Ns`                              | Wait, or use `--skip-rate-limit` for the initial load.                                                                                        |
| `FAILED: upload …: DB_UNAVAILABLE: …` (or another code)           | A server-side failure (database, consent ledger, queue). The logs carry its cause. Check the upload with `--upload-id` before retrying.       |
| `FAILED: … timed out after N ms`                                  | A call hung before the upload was created; nothing was created. Run it again.                                                                 |
| `FAILED: upload create timed out …; a pending upload may exist …` | A pending upload may exist, but it never starts on its own; run it again.                                                                     |
| `FAILED: upload … state unknown after timeout — …`                | A call hung after the upload was created. It may still start: run `--upload-id <id>` and only retry if it never started. Nothing was deleted. |
| `FAILED: upload … started; check with --upload-id … (…)`          | The upload started, then a status or counts read failed. It is processing: do not run it again; read it with `--upload-id <id>`.              |
| `WARNING: upload …: its CSV was left in storage (…)`              | The upload failed and its stored CSV could not be deleted; tell the platform team the upload id.                                              |
| `upload … never started; it is safe to run the upload again`      | From `--upload-id`: the run stopped before the start. Run the upload again.                                                                   |
| `status: file_failed (…)`                                         | The worker rejected the whole file; nothing was processed.                                                                                    |

## What is recorded

- The upload belongs to the coordinator (`bulk_uploads.uploaded_by` is the coordinator's login, as for a portal upload).
- The attestation is in the consent ledger exactly as for a portal upload: the coordinator as subject and `source = bulk_upload:<upload id>:v<n>`.
- Only the logs name the operator, next to the upload id and the coordinator id; they never carry row data.

Do not tell anyone to sign in until the first-login terms screen is live.
