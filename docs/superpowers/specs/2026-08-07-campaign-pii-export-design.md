# Campaign PII Export API — Design (interim)

- **Ticket:** aggregator-dpg#579 (`[campaign-manager] Full participant PII export`)
- **Umbrella:** Blue-Dots-Economy/signals-dpg#237 (Raya & email integrations for campaign management)
- **Date:** 2026-08-07
- **Status:** Approved design, pre-implementation
- **Scope:** interim / prototype-grade. Deliberately time-boxed; several production controls are consciously deferred (see §11).

## In Plain Terms

An external "campaign manager" prototype needs to pull the full participant data
(including personal details) for a set of profiles it owns, so a network admin
can review it. This adds one API to the aggregator: the caller sends a list of
profile ids, the aggregator fetches and decrypts those profiles from Signals,
writes them to a CSV in private cloud storage, and emails a short-lived download
link to a configured network-admin address. The personal data never travels in
the email itself — only a time-limited link — and the caller never receives the
personal data directly.

## 1. Context & existing building blocks

Everything this feature needs already exists in `aggregator-dpg`; nothing new is
required on the Signals side.

- **Signals decrypt** — `POST /api/v1/admin/participant/decrypt` returns the
  **decrypted `item_state`** (public + private fields merged) for a set of
  `item_ids`, scoped by the item creator's `onboarded_by_org_id`. It is reached
  through the aggregator's `signalstack-writer.fetchDecryptedProfiles({ actingOrgId, itemIds })`
  (`packages/signalstack-writer`), which holds the Signals admin key server-side.
  It returns `{ profiles, skipped }` — `skipped` holds ids not found / not owned
  / undecryptable, with **no distinction** (no existence leak).
- **A working sibling** — `POST /v1/dashboard/export/profiles`
  (`apps/api/src/routes/dashboard.ts`) already decrypts selected items and streams
  a CSV to the caller synchronously, using `buildDecryptedProfilesCsv`
  (`apps/api/src/services/profile-csv.ts`). This feature is the async, S3-delivered,
  network-admin-routed evolution of that route.
- **S3** — `apps/api/src/services/object-storage/index.ts` already does presigned
  PUT/GET, `putObject`, and HEAD against the configured `S3_BUCKET` (real S3 in
  prod, MinIO locally).
- **Mailer** — `apps/api/src/services/mailer/` (`getMailer()`, SMTP + SES adapters)
  is the aggregator's own mail path (not the notification-service). Migration to
  notification-service is a separate, later effort.

## 2. Ownership & auth model (interim)

- The **only** thing that proves ownership is the Signals decrypt scoping: called
  with `x-acting-org-id = <org's Signals org id>`, Signals returns **only** items
  that org onboarded; everything else lands in `skipped`. So a request can never
  retrieve another org's data.
- **Interim auth** is the `x-org-id` request header carrying the caller's
  **Signals org id**, passed straight through as `actingOrgId`. There is no token
  and no shared secret in the interim. Accepted, recorded risk: anyone who knows a
  valid `org_id` can export **that org's own** data. This is acceptable only for
  local/prototype testing and **must not** ship to production without the Keycloak
  token model (aggregator-dpg#576), at which point the org id comes from the
  validated token claim instead of the header — only the auth preHandler changes.

## 3. Endpoint contract

`POST /v1/campaign/export` (behind the `/backend` ingress prefix). Registered as
its **own route group**, outside the session-auth hook (the external caller has
no session).

**Request**

- Header: `x-org-id: <signals org id>` (required).
- Header (optional): `x-request-id` — propagated to the `signalstack-writer` call
  for cross-service tracing (per the observability rule).
- Body (Zod):
  ```jsonc
  {
    "item_ids": ["<uuid>", "..."], // min 1, max EXPORT_MAX_ITEM_IDS
    "purpose": "campaign audit", // optional free-text
  }
  ```

**Responses (synchronous)**

| Status | Code                    | When                                                                        |
| ------ | ----------------------- | --------------------------------------------------------------------------- |
| `202`  | —                       | Accepted; background export started. Body: `{ "status": "queued" }`         |
| `400`  | `BAD_REQUEST`           | Malformed body, non-uuid ids, empty list, or over `EXPORT_MAX_ITEM_IDS`     |
| `401`  | `MISSING_ORG_ID`        | No `x-org-id` header                                                        |
| `503`  | `EXPORT_NOT_CONFIGURED` | A required dependency is unconfigured (admin email, S3, Signals, or mailer) |

After `202` the work is **fire-and-forget**: no status is surfaced to the caller.
The only delivery signal is the email to the network admin.

## 4. Background job — `runExport({ orgId, itemIds, purpose, requestId }, deps)`

Kicked off **un-awaited** from the handler, wrapped in `.catch(logError)` so a
failure can never become an unhandled rejection. `deps` are injected so the job
is unit-testable with fakes: `{ ss, mailer, storage, config, logger }`.

Steps:

1. **Resolve + decrypt** — `ss.fetchDecryptedProfiles({ actingOrgId: orgId, itemIds, requestId })`
   → `{ profiles, skipped }`. On `Err`: log failure, abort (no email).
2. **Empty guard** — `profiles.length === 0` (nothing owned/found): log, **no file,
   no email**, done.
3. **Homogeneity check** — collect distinct `(item_domain, item_type)` across
   resolved profiles. If more than one distinct pair → log error, abort, no email.
   (Only detectable post-decrypt, so it is an async abort. A well-formed request
   from a single aggregator/coordinator is inherently single-domain.)
4. **Build CSV** — `buildDecryptedProfilesCsv(profiles)` (reused). Homogeneous type
   ⇒ stable columns.
5. **Upload** — `putObject('campaign-exports/{orgId}/{ISO-timestamp}.csv', buffer, 'text/csv')`
   into the existing `S3_BUCKET`.
6. **Presign** — new `signExportDownloadUrl(key)` — GET presign, TTL
   `EXPORT_URL_TTL_SECONDS`.
7. **Email** — `mailer.send()` to `EXPORT_NETWORK_ADMIN_EMAIL` (§6 shape).
8. **Log success** — counts + S3 key only. **Never** log `item_state`, PII, or the
   presigned URL.

## 5. CSV format

Straight reuse of `buildDecryptedProfilesCsv`: columns `item_id, item_network,
item_domain, item_type, created_at, updated_at` plus the flattened `item_state`
fields. Single item_type per file ⇒ consistent columns.

## 6. Email format

- **To:** `EXPORT_NETWORK_ADMIN_EMAIL` (may be a comma-separated list).
- **Subject:** `PII export ready — <domain> (<n> records)`.
- **Body (HTML + plain text):**
  - Requested by org: `{orgId}`
  - Purpose: `{purpose || "—"}`
  - Records exported: `{profiles.length}`
  - Skipped (not found / not owned): `{skipped.length}`
  - Download (expires `{expiresAt}`): `{presignedUrl}`
  - Note: the link is time-limited and the file contains personal data.

## 7. Configuration (new env, read once at startup via config)

| Var                          | Meaning                           | Default                                 |
| ---------------------------- | --------------------------------- | --------------------------------------- |
| `EXPORT_NETWORK_ADMIN_EMAIL` | Recipient(s) of the download link | — (unset ⇒ `503 EXPORT_NOT_CONFIGURED`) |
| `EXPORT_MAX_ITEM_IDS`        | Max ids accepted per request      | `500`                                   |
| `EXPORT_URL_TTL_SECONDS`     | Presigned-GET link TTL            | `3600`                                  |

Reused as-is: `S3_BUCKET`, `SIGNALSTACK_BASE_URL` / `SIGNALSTACK_ADMIN_KEY`, the
existing mailer config. The S3 prefix `campaign-exports/` is a code constant.

## 8. Error handling

- External calls keep the repo rules (timeout + retry + typed errors). The
  `signalstack-writer` already applies them; `object-storage` / `mailer` use their
  existing wrappers.
- **Sync** failures → `400 / 401 / 503`.
- **Async** failures → structured `logger.error` (`operation`, `status: 'failure'`,
  `error`, `error_type`, `latency_ms`), never re-thrown to the top, never containing
  PII. No retry, no persistence (interim).

## 9. Testing (Vitest)

Service tests inject fakes (`SignalStackWriterFake` seeded with profiles; fake
`storage` and `mailer`):

- Happy path — CSV built, uploaded, email sent with correct counts.
- Partial — some ids `skipped`; skipped count appears in the email; resolved rows
  still exported.
- Empty — 0 resolved ⇒ no upload, no email.
- Mixed type/domain — abort, no email.
- Decrypt `Err` — abort, no email.

Route tests: `202` on valid input; `400` on bad/empty/over-limit body; `401`
missing `x-org-id`; `503` when a dependency is unconfigured. No real network/S3.

## 10. File / module layout

```
apps/api/src/routes/campaign-export.ts                 # route group + requireOrgId preHandler + Zod + 202
apps/api/src/services/campaign-export/index.ts         # runExport orchestrator + step fns
apps/api/src/services/campaign-export/__tests__/…      # service unit tests
apps/api/src/services/object-storage/index.ts          # + signExportDownloadUrl()
apps/api/src/routes/__tests__/campaign-export.test.ts  # route tests
apps/api/src/config.ts (+ env schema)                  # EXPORT_* vars
apps/api/src/app.ts / server.ts                        # register the new route group (outside session auth)
```

No new package — the mailer, S3, and Signals client are all app-local `apps/api`
services, so the job lives beside them. Two clean seams for later: swap the
un-awaited call for a durable queue enqueue (worker), and swap the `x-org-id`
preHandler for KC-token validation (#576).

## 11. Deferred / out of scope

- **S3 lifecycle auto-delete** — owned by `bluedots-automation` (infra). Until it
  exists, exported objects **persist** in S3 (the presigned link still expires on
  its TTL). Recorded, accepted for interim.
- **Keycloak-token auth** (#576) — replaces the `x-org-id` header.
- **Durable execution** — inline background task is not restart-safe; a crash
  mid-export loses that job with no retry.
- **Audit table** — a single unified metadata-audit table is planned later; this
  feature writes no audit row for now.
- **Idempotency key** — dropped for the interim (no persistence to dedupe against).
- **Consent / OTP gate** — not required for export in the interim.
- **notification-service** migration — this feature uses the aggregator's own
  mailer.
