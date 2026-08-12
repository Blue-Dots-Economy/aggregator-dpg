# Campaign API Contract Standard (normalization)

**Umbrella:** Blue-Dots-Economy/signals-dpg#237 · **Applies to:** aggregator-dpg#577 (voice), #578 (email), #579 (export)
**One of three specs:** this (contract) · async batch-processing · audit (#617). **Status:** Design for review · **Date:** 2026-08-12

## 1. Purpose

The three campaign endpoints are the **same request shape over a different channel**. This spec fixes the one contract they all conform to, so they read as one family and a client integrates once. Only the per-channel _content block_ and _side-effect_ differ. The job/status engine is specced separately (async batch-processing); audit separately (#617).

## 2. Shared envelope

**Endpoint:** `POST /v1/campaign/{voice|email|export}`

**Auth (identical for all three):**

- `Authorization: Bearer <Keycloak access token>`.
- `azp` must be in `CAMPAIGN_MANAGER_ALLOWED_AZP` (else `401`).
- Acting org is read from the token's `signalstack_org_id` claim — **never** a header or body field.
- Ownership is enforced downstream: the Signals `participant/decrypt` call is scoped to that org (`x-acting-org-id`), so only participants the org onboarded resolve; unowned ids are **skipped, never leaked**.

**Headers:** `Idempotency-Key` (optional; request-level idempotency), `x-request-id` (optional; propagated as the correlation/trace id).

**Body** (`application/json`) — a fixed three-key envelope: `item_ids`, `metadata`, `content`.

```jsonc
{
  "item_ids": ["<uuid>", "..."], // required
  "metadata": [
    // optional; open list of {key, value}
    { "key": "purpose", "value": "Q3 follow-up" },
    { "key": "consent", "value": "<ref-or-json>" },
  ],
  "content": {/* endpoint-specific payload, its own schema — see §6 */},
}
```

| Field      | Type                               | Required | Notes                                                                                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `item_ids` | `uuid[]`                           | yes      | 1 … `CAMPAIGN_<CHANNEL>_MAX_ITEMS`; over cap → `400` (rejected, never truncated)                                                                                                                                                                                                                             |
| `metadata` | `{ key: string, value: string }[]` | no       | **Open** key/value list for cross-cutting inputs (e.g. `purpose`/`reason`, `consent`). Keys can be **added or removed without changing this contract** — recognised keys are interpreted where relevant (audit, consent); unknown keys are accepted and ignored. Structured values are JSON-encoded strings. |
| `content`  | `object`                           | per §6   | Endpoint-specific payload with its **own schema** — the only part that varies by channel.                                                                                                                                                                                                                    |

Strictness: the **top-level envelope is strict** (only these three keys); **`content` is strict** against its per-endpoint schema (§6); **`metadata` is open** by design. `purpose`/`consent` are metadata keys, not top-level fields — the audit log (#617) sources them from `metadata`.

## 3. Success response — `202`

```json
{ "status": "queued", "requested": 42, "job_id": "<uuid>", "message": "..." }
```

`202` means **durably queued**, not done. `job_id` is the handle for the poll endpoint (§4) and equals the `correlation_id` in the audit log (#617).

## 4. Errors (shared envelope)

```jsonc
{ "error": { "code", "title", "detail", "fields"?, "requestId", "timestamp" } }
```

Shared codes: `UNAUTHORIZED` (401) · `FORBIDDEN` (403; sub-codes `MISSING_SIGNALSTACK_ORG` / `MISSING_AGGREGATOR_ID`) · `SCHEMA_VALIDATION` / `BAD_REQUEST` (400) · `<CHANNEL>_ENQUEUE_FAILED` (503). Channel-specific extensions are allowed and documented per channel (e.g. email `UNKNOWN_PLACEHOLDER` 400).

## 5. Poll endpoints (uniform)

- **`GET /v1/campaign/{channel}/{job_id}`** — request-level status + **derived** counts + paginated per-item rows (`item_id`, `status`, `provider_ref`, skip/error). Org-scoped; another org's job → **403** (never a 404 existence-leak). Mirrors `GET /v1/bulk-uploads/:id`.
- **`GET /v1/campaign/{channel}`** — paginated, org-scoped list.

## 6. `content` — per-endpoint schema (the only variance)

`content` is an object validated against a per-endpoint schema; swapping channels swaps only this object.

- **voice:** `{ agent_id }` (required) + optional Raya passthrough forwarded **as-is** (no server defaults): `schedule?`, `max_retries?`, `retry_after_hrs?`, `selected_statuses?`, `concurrency?`. Shape-validated only.
- **email:** `{ subject (≤200), body_markdown (≤20 000), reply_to? }`. Placeholders `{{name|first_name|last_name|email|phone}}`; an unknown token → `400 UNKNOWN_PLACEHOLDER` at submit (fail-closed).
- **export:** `{}` — empty/reserved in v1. Field-set and delivery are resolved from `CAMPAIGN_EXPORT_FIELDS` (`contact`|`full`) and `CAMPAIGN_EXPORT_RECIPIENT` (`requester`|`network_admin`) config, not the body.

## 7. Config (this spec)

`CAMPAIGN_<CHANNEL>_MAX_ITEMS`, `CAMPAIGN_MANAGER_ALLOWED_AZP` (shared). Rate-limit / retry / dedup config live in the async batch-processing spec.

## 8. Cross-references

- Job lifecycle, tables, dedup, rate limiting, retries, handlers → **async batch-processing spec**.
- Accountability log (5W-2H, append-only), `job_id = correlation_id` → **#617 audit spec**.
