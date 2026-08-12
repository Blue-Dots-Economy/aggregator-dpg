# Campaign Async Job Model — idempotency, rate limiting, two-level status + audit

**Umbrella:** Blue-Dots-Economy/signals-dpg#237
**Applies to:** aggregator-dpg#577 (voice), #578 (email), #579 (export)
**Supersedes:** the standalone append-only audit table (#617) — the two-level tables below _are_ the audit record (see §8). The "per-recipient status is v2" deferral in the #578 spec and the "logs counts only / no job_id" behaviour in the #579 PR.
**Status:** Design for review · **Date:** 2026-08-12

---

## 1. Why this exists

All three campaign endpoints are **async** and **bulk** (`item_ids[]` → 202). As built/planned they share three gaps: no caller-visible job handle, no durable per-item status, and no idempotency/dedup. This spec closes them **uniformly** across the three channels by **reusing aggregator-dpg's existing batch infrastructure**, and adds a two-level status model that also serves as the DPDP audit log. **Nothing here is deferred to v2.**

Design rule: one **shared envelope + shared machinery**; the only per-channel differences are the _content block_ and the _external side-effect_. #577 and #578 are the same shape (send to participants over a channel); #579 differs only in that its side-effect is a file + link.

## 2. Reused infrastructure (do not reinvent)

| Concern                       | Reuse                                                                                                                                                        | Location                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Queue                         | BullMQ over ioredis, `createRedisConnection`, `DEFAULT_JOB_OPTS` (`attempts:3`, exp backoff), `QueueName` enum                                               | `packages/queue/src/index.ts`                 |
| Worker roles                  | add a `campaign` role beside `file/row/finalise/cron`                                                                                                        | `apps/worker/src/worker-roles.ts`, `main.ts`  |
| Batch lifecycle table pattern | model `campaign_request` on `bulk_uploads` (pure lifecycle state + status enum)                                                                              | `packages/db-schema/src/schema.ts`            |
| Rate limiter                  | `consume({namespace,key,windowSeconds,max})` fixed-window                                                                                                    | `apps/api/src/services/rate-limiter/index.ts` |
| Signals decrypt               | `fetchDecryptedProfiles({requestId, actingOrgId, itemIds})` → `POST /api/v1/admin/participant/decrypt`, extended with the #522 `contact`/`fields` projection | `packages/signalstack-writer/src/http.ts`     |
| Mailer (worker-side)          | the `packages/mailer` shared adapter introduced by #602 (`send({to,subject,html,text,replyTo})`)                                                             | `packages/mailer`                             |
| Status poll pattern           | mirror `GET /v1/bulk-uploads/:id` (DB row + rollup counts, 403 cross-org)                                                                                    | `apps/api/src/routes/bulk-uploads.ts`         |

**Deviation from bulk-upload (deliberate):** bulk-upload keeps per-row state in **Redis, DEL'd at finalise**. Campaign per-item state is **durable Postgres**, because it must (a) survive job completion for status polling, (b) carry provider refs (`call_id`/`message_id`), and (c) serve as the audit record. Redis remains only for the egress rate gate.

## 3. Data model — two durable tables

### 3.1 `campaign_request` (request/batch level — one row per accepted request)

| Field                                                                                                                                                      | Purpose (5W-2H)          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `id uuid PK`, exposed to caller as **`job_id`**                                                                                                            | handle                   |
| `idempotency_key text` (unique when present)                                                                                                               | request idempotency (§4) |
| `channel enum('voice','email','export')`                                                                                                                   | What                     |
| `status enum('queued','processing','partial','completed','failed')`                                                                                        | job status               |
| `actor_user_id`, `actor_org_id` (`signalstack_org_id`), `actor_azp`                                                                                        | **Who**                  |
| `purpose text`                                                                                                                                             | **Why**                  |
| `pii_fields text[]` (e.g. `name,email,phone` \| `full`)                                                                                                    | **What** (PII touched)   |
| `destination text` (`raya` \| `ses:<addr>` \| `s3://bucket/key`)                                                                                           | **Where**                |
| `endpoint text`, `correlation_id`, `trace_id`, `request_ip`                                                                                                | **How**                  |
| `channel_params jsonb` (email: subject/body_markdown/reply_to; voice: agent_id/schedule/concurrency/selected_statuses; export: field-set + recipient-mode) | How (channel content)    |
| `requested_count, resolved_count, skipped_count, failed_count, sent_count int`                                                                             | **How-many**             |
| `error_code text`, `requested_at`, `started_at`, `completed_at`, `created_at`, `updated_at`                                                                | When / outcome           |

Indexes: `(actor_org_id, status)`, `(channel, status)`, unique `(idempotency_key) WHERE idempotency_key IS NOT NULL`.
**Immutability for audit:** `actor_*`, `channel`, `pii_fields`, `purpose`, `requested_*`, item set are **write-once** (DAL exposes no UPDATE on them); rows are **never hard-deleted**. Only `status`/counters/`*_at`/`error_code` mutate. This satisfies DPDP accountability without a separate event log.

### 3.2 `campaign_request_item` (row/item level — one row per request × item)

| Field                                                                                                                                                        | Purpose          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `id uuid PK`, `request_id uuid FK`                                                                                                                           | link             |
| `channel enum` (denormalised for the dedup index)                                                                                                            | dedup            |
| `item_id uuid`                                                                                                                                               | the Signals item |
| `status enum('pending','resolved','skipped_not_owned','skipped_no_contact','duplicate_active','submitted','sent','failed')`                                  | per-row status   |
| `provider_ref text` (voice: `call_id`; email: `message_id`; export: `included`), `raya_batch_id text`, `last_provider_status text` (voice, synced from Raya) | provider linkage |
| `skip_reason` / `error_code text`, `attempts int`, `created_at`, `updated_at`, `completed_at`                                                                | outcome          |

Indexes: `(request_id)`, unique `(request_id, item_id)`.
**Cross-aggregator dedup (§4):** partial unique **`campaign_item_active_unique (channel, item_id) WHERE status IN ('pending','resolved','submitted')`**.

## 4. Idempotency & dedup

Three layers, mirroring bulk-upload's (jobId + Lua-guard + DB-constraint) discipline:

1. **Request idempotency** — optional `Idempotency-Key` header → `campaign_request.idempotency_key` unique. Replay returns the _same_ `job_id` + `202`, never a second job. BullMQ enqueue uses `jobId = campaign_request.id`.
2. **Cross-aggregator item dedup (explicitly required).** On enqueue, insert one `campaign_request_item` per id. The partial-unique `campaign_item_active_unique` means **a second active request on the same `(channel, item_id)` — from the same or a different aggregator — cannot insert an active row.** On conflict, the item is recorded as **`duplicate_active`** (not in the active predicate, so the insert succeeds in that terminal state) and reported back as skipped-duplicate; it does **not** fail the whole request. Example: aggregator A queues voice on `item 1`; while it is `queued/submitted`, any voice request on `item 1` (A or B) skips that item as `duplicate_active`. Dedup is **per channel** (a voice hold does not block an email).
3. **Send-once under retries** — job-level retry stays safe (we keep `DEFAULT_JOB_OPTS attempts:3`) because each item's **terminal status guards re-execution**: the worker never re-sends an item already `sent`/`submitted` (same replay-safety as the bulk Lua `SADD`). This removes the #578 spec's `attempts:1` compromise — we get durability _and_ no duplicate calls/emails.

## 5. Rate limiting

Two distinct limiters — reuse `consume()` for both, with different fail modes:

- **Ingress (per caller org)** — before enqueue: `consume({namespace:'campaign-<channel>-submit', key: actor_org_id, windowSeconds: CAMPAIGN_SUBMIT_WINDOW_SECONDS, max: CAMPAIGN_SUBMIT_MAX})` → over-limit `429` + `Retry-After`. Plus a **max-concurrent-active-requests-per-org** cap (count query on `campaign_request WHERE status IN ('queued','processing')`). Fail-**open** (current limiter behaviour) is acceptable here.
- **Egress (per external provider) — the important one, since these are third-party calls.**
  - **Raya:** documented limit **~1 call / 20s**. Before each Raya call, a **distributed gate**: `consume({namespace:'raya-egress', key:'global', windowSeconds:20, max:1})`; if not allowed, wait `retryAfterSeconds`. On HTTP **429, honour `Retry-After` + exponential backoff**; on 401 fail terminally. **Egress must fail _closed_** — if Redis is unavailable, degrade to a conservative fixed local delay (≥20 s), never hammer Raya. (Raya's own `concurrency` + `max_retries`/`retry_after_hrs` in the start call are set conservatively too — see §7.3.)
  - **Email (SES/SMTP):** bounded worker concurrency `EMAIL_SEND_CONCURRENCY` (default 5) + provider-side rate as needed.

## 6. Job status & the poll endpoint

`job_id` is returned in every `202` (`{ status:"queued", requested, job_id, message }`).

**`GET /v1/campaign/{channel}/{job_id}`** — mirrors `GET /v1/bulk-uploads/:id`:

- Auth: same `requireAuth` aggregator scoping; a job belonging to another org → **403** (never 404-leak).
- Returns the **request-level report** (status, counts, purpose, destination, timestamps) + **row-level detail** (`item_id`, status, `provider_ref`/`call_id`/`message_id`, skip/error reason) — paginated for large batches.
  Also `GET /v1/campaign/{channel}` (paginated list, org-scoped). The campaign-manager **polls these tables** for the batch report with per-row detail; no data ever pushed back to it.

## 7. Per-channel processing

Shared phase 1 (API): auth (KC `azp` allowlist + `signalstack_org_id`) → validate → ingress rate check → **insert `campaign_request` (`queued`) + `campaign_request_item` rows (dedup applied)** → enqueue `campaign-process` (jobId = request id) → `202 {job_id}`. Shared phase 2 (worker, `campaign` role): mark `processing` → **decrypt owned items in chunks** (`fetchDecryptedProfiles`, #522 projection, `CAMPAIGN_DECRYPT_CHUNK` default 100) → per channel below → roll counts up to `campaign_request`, set `completed`/`partial`/`failed`. Unowned ids come back skipped → item `skipped_not_owned`.

### 7.1 Export (#579)

Decrypt `contact` (or full, per `CAMPAIGN_EXPORT_FIELDS`) → build CSV (formula-injection-neutralised, RFC-4180) → upload to private S3 → mint pre-signed URL → email link (recipient per `CAMPAIGN_EXPORT_RECIPIENT` = `requester` | `network_admin`) via `packages/mailer`. Each resolved item → `sent`/`included`; S3 object auto-deletes via the **≥1-day lifecycle rule** (bluedots-automation); audit rows persist. Job retry safe (idempotent rebuild; overwrites same key).

### 7.2 Email (#578)

Decrypt `contact:['email', +placeholder fields]` → render Markdown→sanitised HTML once → per recipient (bounded concurrency, egress §5): skip `skipped_no_contact` if no email; else send via `packages/mailer`, set item `sent` + `message_id`. Unknown placeholder → `400` at submit (unchanged). Retries safe via per-item `sent` guard.

### 7.3 Voice (#577) — Raya two-step

Decrypt `contact:['name','phone']`. Then the two Raya calls (X-API-Key server-side only), each through the Raya egress gate:

1. **`POST /batch`** — `agent_id`, `batch_name`, `contacts[]` = `{contact_name, contact_phone, country_code, ref:<item_id>}`. The per-contact **`ref` passthrough carries our `item_id`** so row status reconciles later. Store `raya_batch_id` on the request + each item (`submitted`).
2. **`POST /batch/{batchId}/start`** — `schedule` + `concurrency` (kept low) + `max_retries`/`retry_after_hrs` + `selected_statuses:['Pending']`. This is the trigger.

> The JFC/admin approval flow in the vendor doc is **out of scope** here.

**Reconciliation (per-row outcomes are asynchronous on Raya's side):** a repeatable **`campaign` cron tick** (reuse the cron worker-role pattern) polls **`GET /batch/{raya_batch_id}/contacts`** for active voice requests, matching on `ref` → updates `campaign_request_item.last_provider_status` (`Pending`/`Answered`/`Unanswered`/`Failed`) and finalises the request when all rows are terminal. Single ad-hoc calls may use `/call` with `agent_args`; batch is the default.

## 8. Audit (folds in #617)

The two tables **are** the audit log; no separate table:

- **`campaign_request`** = the request-level 5W-2H record (Who/What/Why/When/Where/How/How-many), write-once on identity fields, never deleted, retained independently of the exported S3 artifact.
- **`campaign_request_item`** = per-item audit (which participant's PII was used, outcome, provider ref) — **ids/refs only, never PII values** (no name/email/phone stored; the CSV/email content lives only in S3/the mail transport).
  Recommendation: **close #617's separate `campaign_pii_audit`** in favour of this. (Flagged for confirmation.)

## 9. Configuration

| Var                                                      | Default                            | Purpose                                                         |
| -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `CAMPAIGN_SUBMIT_WINDOW_SECONDS` / `CAMPAIGN_SUBMIT_MAX` | 60 / 20                            | ingress per-org enqueue limit                                   |
| `CAMPAIGN_MAX_ACTIVE_PER_ORG`                            | 5                                  | concurrent active requests per org                              |
| `CAMPAIGN_CONCURRENCY`                                   | 2                                  | parallel `campaign` jobs per worker process                     |
| `CAMPAIGN_DECRYPT_CHUNK`                                 | 100                                | item_ids per Signals decrypt call                               |
| `RAYA_EGRESS_WINDOW_SECONDS` / `RAYA_EGRESS_MAX`         | 20 / 1                             | Raya egress gate                                                |
| `EMAIL_SEND_CONCURRENCY`                                 | 5                                  | parallel email sends per job                                    |
| `CAMPAIGN_EXPORT_FIELDS`                                 | `contact`                          | `contact` \| `full` (allowlist-ceilinged)                       |
| `CAMPAIGN_EXPORT_RECIPIENT`                              | `requester`                        | `requester` \| `network_admin` (+ `EXPORT_NETWORK_ADMIN_EMAIL`) |
| `CAMPAIGN_<CHANNEL>_MAX_ITEMS`                           | export 500 / email 200 / voice 500 | per-request cap                                                 |
| `CAMPAIGN_ITEM_RETENTION_DAYS`                           | (retain)                           | audit retention (rows persist past S3 TTL)                      |

Reused: `REDIS_URL`, `SIGNALSTACK_*`, `MAIL_PROVIDER`/`SMTP_*`/`SES_*`, `S3_*`, `CAMPAIGN_MANAGER_ALLOWED_AZP`.

## 10. Acceptance (all channels, v1 — none deferred)

- Every request returns a `job_id`; `GET /v1/campaign/{channel}/{job_id}` returns request-level status + per-row detail (incl. `call_id`/`message_id`), org-scoped (403 cross-org).
- Re-submitting the same `Idempotency-Key` returns the same `job_id`, runs once.
- A second active request on the same `(channel, item_id)` from **any** aggregator records that item `duplicate_active` and does not double-act.
- Job retries never double-call/-email (per-item terminal-status guard).
- Raya calls respect ~1/20s + 429 `Retry-After`; egress gate fails closed.
- Audit rows (request + item) persist after the export S3 object is auto-deleted; no participant PII value is stored in either table.

## 11. Open items

1. **Confirm #617 is superseded** by these tables (recommended) vs. keeping a separate audit log.
2. **Voice reconciliation cadence** — cron interval for polling `/batch/{id}/contacts` (proposed 5 min) and when to stop (all rows terminal or max age).
3. **Export recipient email resolution** when `requester` mode + token has no `email` claim — resolve from the aggregator record (per #579 §11).
4. Consent gating remains **deferred** (separate spec); `campaign_request` has no consent column yet.
