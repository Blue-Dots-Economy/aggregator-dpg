# Campaign Async Batch Processing

**Umbrella:** Blue-Dots-Economy/signals-dpg#237 · **Applies to:** aggregator-dpg#577 (voice), #578 (email), #579 (export)
**One of three specs:** contract (normalization) · this (engine) · audit (#617). **Status:** Design for review · **Date:** 2026-08-12

The engine behind the contract spec. **Audit is out of scope here** — it lives in #617 and links to a job by `job_id = correlation_id`. These tables are purely operational.

## 1. Reuse decision (option C)

Reuse aggregator-dpg's bulk **machinery**, not its table:

- **Reuse:** `packages/queue` BullMQ + `DEFAULT_JOB_OPTS`; the `worker-roles` split (add a `campaign` role beside `file/row/finalise/cron`); `services/rate-limiter` `consume()`; the jobId-dedup + Lua-guard replay-safety discipline; the `GET /v1/bulk-uploads/:id` poll pattern; the `last_progress_at` watchdog pattern.
- **New tables, not `bulk_uploads`:** that table is CSV-upload-shaped (`s3Key`/`s3Etag`/`schemaId`/`participantType`/`errorsCsvS3Key`, a file-lifecycle status enum) and its per-row state is **Redis keyed by CSV rowIndex, DEL'd at finalise**. Campaign work is keyed by `item_id`, needs a durable provider ref, and must be **pollable after completion** — so we **recreate the row-model in durable Postgres**.

## 2. Tables (operational only — no audit fields)

### 2.1 `campaign_job` (batch/request level)

| Column                                                              | Purpose                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id uuid PK` (= `job_id`)                                           | handle returned in 202                                                                                                                          |
| `aggregator_id`                                                     | owner — poll scoping                                                                                                                            |
| `channel enum('voice','email','export')`                            | which handler                                                                                                                                   |
| `status enum('queued','processing','partial','completed','failed')` | lifecycle                                                                                                                                       |
| `status_reason text`                                                | last transition detail                                                                                                                          |
| `channel_params jsonb`                                              | request content (voice: agent_id + optional Raya passthrough; email: subject/body_markdown/reply_to; export: resolved field-set/recipient mode) |
| `idempotency_key text`                                              | request idempotency (unique when present)                                                                                                       |
| `last_progress_at`                                                  | watchdog heartbeat                                                                                                                              |
| `created_at`, `updated_at`, `completed_at`                          | timing                                                                                                                                          |

Indexes: `(aggregator_id, status)`, unique `(idempotency_key) WHERE idempotency_key IS NOT NULL`.
**Counts are derived** (`COUNT … GROUP BY status` over `campaign_job_item`) at poll time — no counter columns, no drift.

### 2.2 `campaign_job_item` (row/item level — durable Postgres row-model)

| Column                                                                                                                      | Purpose                  |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `id uuid PK`, `job_id uuid FK`                                                                                              | link                     |
| `channel enum`, `item_id uuid`, `action text`                                                                               | unit of work + dedup key |
| `status enum('pending','resolved','skipped_not_owned','skipped_no_contact','duplicate_active','submitted','sent','failed')` | per-item status          |
| `provider_ref text` (`call_id`/`message_id`), `raya_batch_id text`, `last_provider_status text`                             | provider linkage         |
| `error_code` / `skip_reason text`, `attempts int`                                                                           | outcome                  |
| `created_at`, `updated_at`, `completed_at`                                                                                  | timing                   |

Indexes: `(job_id)`, unique `(job_id, item_id)`, partial-unique **`(item_id, action) WHERE status IN ('pending','resolved','submitted')`** (§3). Rows are **retained** (not DEL'd); the audit record persists separately in #617.

## 3. Idempotency & dedup

1. **Request-level idempotency** — `Idempotency-Key` header → `campaign_job.idempotency_key` unique; a replay returns the **same `job_id` + 202**, runs once. BullMQ enqueue uses `jobId = campaign_job.id`.
2. **Item-level active dedup** — partial-unique `(item_id, action)` over active states (`pending`/`resolved`/`submitted`); **global (cross-aggregator)**. A colliding item is recorded **`duplicate_active`** (a terminal state, outside the predicate, so the insert succeeds) and reported skipped — **without revealing which aggregator holds the active lock**. **Per-channel config `CAMPAIGN_<CHANNEL>_DEDUP`: voice ON, email OFF, export OFF.** No cooldown — only concurrent in-flight is blocked.
3. **Retry-safety** — a per-item **terminal-status guard** stops re-acting on an item already `submitted`/`sent` when a job retries (mirrors the bulk Lua `SADD` replay-safety). This gives durability _and_ no duplicate calls/emails without an `attempts:1` compromise.

## 4. Rate limiting (per channel, two layers)

- **Ingress (per org, `consume()`):** `CAMPAIGN_<CHANNEL>_SUBMIT_WINDOW_SECONDS` / `CAMPAIGN_<CHANNEL>_SUBMIT_MAX`, plus `CAMPAIGN_<CHANNEL>_MAX_ACTIVE_PER_ORG` (count of `queued|processing` jobs). Fail-open is acceptable.
- **Egress (external provider):**
  - **voice/Raya** — a distributed gate on **our** API calls: `RAYA_EGRESS_WINDOW_SECONDS=20` / `RAYA_EGRESS_MAX=1`; honour `429 Retry-After` + exponential backoff on both the create and start calls; **fails closed** (degrade to a conservative local delay if Redis is down — never hammer Raya). _(This paces our two API calls; the campaign `concurrency` field is Raya's own dialing pace, forwarded untouched — §7.)_
  - **email** — `EMAIL_SEND_CONCURRENCY` bounded per-job.
  - **export** — no per-item egress rate; only `CAMPAIGN_DECRYPT_CHUNK` chunking of the Signals decrypt.

## 5. Retries + backoff (per channel)

`CAMPAIGN_<CHANNEL>_ATTEMPTS` (default 3) + exponential backoff, overriding `DEFAULT_JOB_OPTS`. Safe under retry via the §3.3 per-item guard. **Not our retry layer:** Raya's `max_retries`/`retry_after_hrs` (in-campaign re-dial of Unanswered/Failed) — those are caller passthrough (§7), forwarded only if supplied.

## 6. Processing pipeline

**API (sync, → 202):** authenticate → validate → ingress rate check → in one transaction insert `campaign_job` (`queued`) + `campaign_job_item` rows (apply active-dedup for channels with it on) → enqueue `campaign-process` (`jobId = campaign_job.id`) → return `202 {job_id}`. Emit the `requested` audit event (#617).

**Worker (`campaign` role):** mark `processing` → **chunked decrypt** (`fetchDecryptedProfiles` + #522 `contact`/`fields` projection, `CAMPAIGN_DECRYPT_CHUNK`; unowned → item `skipped_not_owned`) → per-channel handler (§7 of the contract / below) → set item terminal statuses → roll job to `completed`/`partial`/`failed`. `last_progress_at` heartbeat; a watchdog re-queues stalled jobs. Emit the `completed` audit event (#617).

## 7. Per-API handlers

|                                  | **Voice (#577)**                                                                                                                                                                                                                                     | **Email (#578)**                                                     | **Export (#579)**                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Decrypt fields                   | `name`, `phone`                                                                                                                                                                                                                                      | `email` + placeholder fields                                         | `contact` or `full` (config)                                  |
| External action                  | 2-step Raya (egress-gated): `POST /batch` (contacts incl. `ref=item_id` passthrough) → `POST /batch/{id}/start` (**forward caller `schedule`/`max_retries`/`retry_after_hrs`/`selected_statuses`/`concurrency` as-is; omit if absent; no defaults**) | render markdown once → per-recipient send (`EMAIL_SEND_CONCURRENCY`) | build CSV → S3 → pre-signed link email (recipient per config) |
| Active dedup `(item_id, action)` | **ON**                                                                                                                                                                                                                                               | OFF                                                                  | OFF                                                           |
| Item terminals                   | `submitted` → (reconciled) / `failed`                                                                                                                                                                                                                | `sent` / `skipped_no_contact` / `failed` (+ `message_id`)            | `resolved`/`included` / `skipped_not_owned`                   |
| Async outcome                    | **reconciliation cron** polls `GET /batch/{raya_batch_id}/contacts`, matches `ref`, updates `last_provider_status`, finalises when all rows terminal                                                                                                 | synchronous within the job                                           | synchronous within the job                                    |
| Retry safety                     | guard on `submitted`                                                                                                                                                                                                                                 | guard on `sent`                                                      | idempotent rebuild (overwrite same S3 key)                    |

## 8. Configuration

`CAMPAIGN_<CHANNEL>_{SUBMIT_WINDOW_SECONDS,SUBMIT_MAX,MAX_ACTIVE_PER_ORG,ATTEMPTS,DEDUP,MAX_ITEMS}`, `RAYA_EGRESS_{WINDOW_SECONDS,MAX}`, `EMAIL_SEND_CONCURRENCY`, `CAMPAIGN_DECRYPT_CHUNK`, `CAMPAIGN_CONCURRENCY` (parallel campaign jobs/process), `CAMPAIGN_EXPORT_FIELDS`, `CAMPAIGN_EXPORT_RECIPIENT` (+`EXPORT_NETWORK_ADMIN_EMAIL`). Reused: `REDIS_URL`, `SIGNALSTACK_*`, `MAIL_PROVIDER`/`SMTP_*`/`SES_*`, `S3_*`.

## 9. Open items

1. **Voice reconciliation cadence** — proposed 5 min; stop polling when all rows terminal or past a max age.
2. **Export recipient email resolution** in `requester` mode when the token has no `email` claim (per #579 §11).
3. **Raya re-dial params** are pure passthrough; whether the campaign-manager UI _exposes_ them is a client concern, not ours.
