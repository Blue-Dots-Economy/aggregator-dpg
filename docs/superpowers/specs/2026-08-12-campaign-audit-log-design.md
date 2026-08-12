# Campaign PII-Action Audit Log

**Umbrella:** Blue-Dots-Economy/signals-dpg#237 · **Ticket:** aggregator-dpg#617 · **Applies to:** #577 (voice), #578 (email), #579 (export)
**One of three specs:** contract (normalization) · async batch-processing · this (audit). **Status:** Design for review · **Date:** 2026-08-12

## 1. Purpose & boundary

A single **append-only** log recording every PII-touching campaign action on the **5W-2H** principle, for DPDP accountability. It is **separate from the operational job/status tables** (`campaign_job` / `campaign_job_item`) — those are mutable and derive counts; this is immutable and never deleted. The two are linked by **`correlation_id = job_id`**. Status polling reads the job tables; compliance/accountability reads this log.

## 2. Principles

- **Append-only / immutable** — one row per lifecycle event (`requested`, then `completed`/`failed`) sharing a `correlation_id`. The DAL exposes no UPDATE/DELETE.
- **No participant PII values** — item ids, counts, and PII _field names_ only. Never a participant name/email/phone. The actor and any export-link recipient are **operator** identities, not participant data.
- **Retained independently** — survives the job rows and any exported S3 artifact (which auto-deletes). Retention is a compliance decision, not tied to job cleanup.

## 3. Table `campaign_pii_audit`

| Group        | Columns                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| key          | `id uuid PK`, `event enum('requested','completed','failed')`, `correlation_id uuid` (= `campaign_job.id`), `created_at`                    |
| **Who**      | `actor_user_id` (KC sub), `actor_org_id` (`signalstack_org_id`), `actor_azp`, `recipient_ref` (export-link recipient — operator, nullable) |
| **What**     | `channel enum('voice','email','export')`, `action text`, `pii_fields text[]` (e.g. `name,email,phone` \| `full`), `item_count int`         |
| **When**     | `requested_at`, `completed_at` (nullable)                                                                                                  |
| **Where**    | `destination text` (`raya` \| `ses:<addr>` \| `s3://bucket/key`), `network`/`instance`, `request_ip`                                       |
| **Why**      | `purpose text`, `consent_ref` (nullable — consent deferred)                                                                                |
| **How**      | `endpoint`, `trace_id`, `status`, `error_code`                                                                                             |
| **How-many** | `requested_count`, `resolved_count`, `skipped_count`, `failed_count`, `sent_count`                                                         |

Indexes: `(actor_org_id, created_at)`, `(correlation_id)`, `(channel, created_at)`.

## 4. Lifecycle

- **On request accept** (API): write a `requested` event — actor, channel/action, `pii_fields`, `item_count`, `purpose`, `endpoint`, `correlation_id`, `requested_at`.
- **On completion** (worker): write a `completed`/`failed` event — final counts, `destination`, `completed_at`, `error_code` — sharing the `correlation_id`.

## 5. Relationship to the other specs

- **Contract spec** returns `job_id`; that value is this log's `correlation_id`.
- **Async batch-processing spec** owns the mutable `campaign_job`/`campaign_job_item` tables and emits the two audit events above; it stores **no** audit fields itself.
- Consent gating remains **deferred** (separate spec); `consent_ref` is present but unused for now.

> Note: an earlier draft folded this into the job tables — reverted. Audit and operational status are deliberately separate tables with different mutability and retention.
