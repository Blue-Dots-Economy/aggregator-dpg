# Bulk upload on a coordinator's behalf: runbook

Our team uses this command to run a bulk upload of seekers or providers for a coordinator who has not signed in yet. It goes through the same pipeline as a portal upload: the same storage, attestation, processing job, row checks and errors report. The upload then appears on that coordinator's Onboarding page and My Blue Dots like any other.

The command ships in the API image (`dist/tools/bulk-upload.js`) and runs in the API pod. The image has no shell or `tar`, so `kubectl cp` does not work: the CSV goes in on stdin and the errors report comes out on stdout.

## Before you start

- **Not on UP until product and legal confirm** that our team can attest, as operator, that the source team holds the participants' consent.
- The coordinator must be **active** (loaded by the org loader or registered normally) and must serve the profile type you upload.
- The CSV is built from the coordinator's bulk-upload template for that profile type and is at most `BULK_UPLOAD_MAX_BYTES` (the same limit as the portal).
- `--operator` is your team's name, with no spaces or `:`, for example `ops-team`. It is recorded on the attestation.

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

The command checks the coordinator and the file, starts the upload, and waits for processing (up to an hour), printing each status change:

```
upload 3f6c…e1 started
  uploaded…
  row_processing…
status: completed
rows: 120 total, 117 passed, 3 failed, 0 skipped
errors report: fetch with --upload-id 3f6c…e1 --errors-csv
```

Note the upload id. Exit code 0 means the upload completed; 1 means it was refused, failed, or is still processing; 2 means the arguments were wrong.

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

Do not run the upload again unless it ended `failed` or `file_failed`; a second run creates a second upload.

## What the messages mean

| Message                                                 | Meaning                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `REFUSED: no coordinator with that email or user id`    | Check the address or id.                                             |
| `REFUSED: coordinator … is pending, not active`         | The coordinator has not been approved yet.                           |
| `REFUSED: coordinator … has no recorded Keycloak login` | The coordinator was never approved through the normal approval step. |
| `REFUSED: coordinator serves …, not …`                  | Wrong `--type`, or the coordinator does not serve it.                |
| `REFUSED: rate limited; retry in Ns`                    | Wait, or use `--skip-rate-limit` for the initial load.               |
| `status: file_failed (header_mismatch)`                 | The CSV headers do not match the template; nothing was processed.    |

## What is recorded

- The upload belongs to the coordinator (`bulk_uploads.uploaded_by` is the coordinator's login, as for a portal upload).
- The attestation is in the consent ledger with the coordinator as subject and `source = bulk_upload:<upload id>:v<n>:provisioned:<operator>`.
- Logs carry the upload id, the coordinator id and the operator, never row data.

Do not tell anyone to sign in until the first-login terms screen is live.
