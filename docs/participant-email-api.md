# Participant Email API (campaign-manager) — Design Spec

**Ticket:** aggregator-dpg#578 · **Umbrella:** Blue-Dots-Economy/signals-dpg#237
**Status:** Draft spec (pre-implementation) · **Branch:** `feat/578-participant-email`

> Sibling of the Participant PII Export (aggregator-dpg#579). Same auth model,
> same Signals decrypt, same durable-worker pattern — this one **sends emails**
> to owned participants instead of exporting their contacts.

---

## 1. What this is

The campaign-manager prototype wants to email a set of **participants it owns**
(follow-ups). It composes the message (subject + Markdown body), optionally with
a few **placeholders** (`{{name}}`, …), and sends us a list of **participant
references** (item ids) — never any email addresses. We resolve each
participant's email **server-side** via Signals `participant/decrypt`, render the
message, send it, and report **per-recipient status** back keyed by `item_id`.

**The personal data never leaves the aggregator** — the prototype only ever sends
item ids and receives item-id-keyed statuses. It never sees an email address.

### Deviation from the issue text

The issue says "via notification-service". **We do not use notification-service** —
we reuse the aggregator's own mailer (`@aggregator-dpg/mailer`, SES/SMTP), the same
one the PII export uses. The `notification-service` cross-repo checklist item is
**N/A**.

---

## 2. Scope (v1)

- One **shared** message (subject + Markdown body) sent to N owned participants.
- **Optional placeholders** — if the body/subject contains a supported
  placeholder we substitute the participant's value; if there are none, it's a
  plain broadcast. Placeholders are **not** required.
- **Markdown** body → rendered to HTML + a plain-text fallback, sanitised.
- **Missing email** → that recipient is skipped and reported (never an error for
  the whole batch).
- **Async** (enqueue → `202 { job_id }`) with a **poll** endpoint for
  per-recipient status.

**Out of scope for v1 (noted for later):** email-contact **consent** gating;
arbitrary `{{profile.<field>}}` placeholders (only the fixed identity set below);
attachments; scheduled/delayed send.

---

## 3. Auth & ownership (identical to the PII export)

- **Token:** Keycloak **user** token minted by the `campaign-manager` client
  (real flow = auth-code + OTP; the client is public, no secret). Sent as
  `Authorization: Bearer <token>`.
- **Client gate:** the route accepts **only** tokens whose `azp` is in
  `CAMPAIGN_MANAGER_ALLOWED_AZP` (default `campaign-manager`) — the **same**
  per-route override the export uses (`authenticate(req, { allowedAzp: campaignManagerAllowedAzp() })`).
  `campaign-manager` stays out of the global `KEYCLOAK_ALLOWED_AZP`, so the token
  is rejected everywhere else (default-deny both ways).
- **Org identity:** taken from the token's **`signalstack_org_id` claim** — never
  from a header or the request body (`403` if the claim is absent).
- **Ownership:** enforced by Signals. The worker decrypts with
  `x-acting-org-id = orgId`; any `item_id` the org doesn't own comes back in the
  decrypt `skipped[]` and is reported as `skipped_not_owned`. There is no local
  `onboarded_by` check and no `x-org-id` header — the org is bound to the token.

---

## 4. API

### 4.1 `POST /v1/campaign/email` — enqueue a send

Validates + enqueues only; returns `202` once the job is durably queued. No PII in
the request or the response.

**Request body** (`application/json`, strict — unknown keys rejected):

| Field           | Type              | Required | Notes                                                                                       |
| --------------- | ----------------- | -------- | ------------------------------------------------------------------------------------------- |
| `item_ids`      | `string[]` (UUID) | yes      | 1 … `EMAIL_MAX_RECIPIENTS` (default 200). Over the cap → `400` (rejected, never truncated). |
| `subject`       | `string`          | yes      | ≤ 200 chars. May contain placeholders. Plain text (not Markdown).                           |
| `body_markdown` | `string`          | yes      | ≤ 20 000 chars. Markdown; may contain placeholders. Rendered server-side.                   |
| `reply_to`      | `string` (email)  | no       | Sets the email `Reply-To`. The `From` is always the aggregator's configured sender.         |
| `purpose`       | `string`          | no       | ≤ 500 chars, audit only, never emailed.                                                     |

**Example**

```jsonc
POST /v1/campaign/email
Authorization: Bearer <campaign-manager user token>
Content-Type: application/json
{
  "item_ids": ["e4e163e7-c4ad-42f9-9550-af6f09267e14",
               "13ccd407-9965-44ff-9d04-2a1561c4f740"],
  "subject": "Hi {{first_name}}, an update on your application",
  "body_markdown": "Hi {{name}},\n\nWe have an **update** for you:\n\n- Step one is complete\n- Step two starts next week\n\nThanks!",
  "reply_to": "campaign@org.example",
  "purpose": "Q3 follow-up"
}
```

**Success — `202 Accepted`**

```json
{ "job_id": "cme_9f3a…", "status": "queued", "requested": 2 }
```

> `202` means durably queued — not sent. Poll the job for outcomes.

**Errors**

| HTTP  | `error.code`           | When                                                                                                      |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `400` | `SCHEMA_VALIDATION`    | bad body: non-UUID / empty / over-cap `item_ids`, missing subject/body, unknown keys                      |
| `400` | `UNKNOWN_PLACEHOLDER`  | subject/body contains a `{{token}}` not in the allow-list (§5) — fail-closed so typos never ship          |
| `401` | `UNAUTHORIZED`         | token missing / invalid / bad signature, **or** `azp` not an allowed campaign-manager client              |
| `403` | `FORBIDDEN`            | token lacks `signalstack_org_id` (`MISSING_SIGNALSTACK_ORG`) or `aggregator_id` (`MISSING_AGGREGATOR_ID`) |
| `503` | `EMAIL_ENQUEUE_FAILED` | job could not be enqueued (e.g. Redis unreachable)                                                        |

### 4.2 `GET /v1/campaign/email/{job_id}` — poll status

Same auth/gate. **Org-scoped:** the job stores its `orgId`; if the caller's token
org ≠ the job's org, returns `404` (a campaign-manager cannot poll another org's
job). Reads the per-recipient results from the job result store.

**`200 OK`**

```jsonc
{
  "job_id": "cme_9f3a…",
  "status": "done", // queued | running | done
  "requested": 2,
  "sent": 1,
  "skipped": 1,
  "failed": 0,
  "results": [
    { "item_id": "e4e163e7-…", "status": "sent", "message_id": "<smtp-id>" },
    { "item_id": "13ccd407-…", "status": "skipped_no_email" },
  ],
}
```

**Per-recipient `status` values**

| Status              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `sent`              | Accepted by the mail transport (`message_id` included).                    |
| `skipped_no_email`  | Participant owned, but has no resolvable email (item + user both empty).   |
| `skipped_not_owned` | `item_id` not owned by the caller's org / not found (Signals `skipped[]`). |
| `failed`            | Transport rejected the send; `reason` carries the mailer error code.       |

**The response is PII-free** — only `item_id` + status (+ a transport `message_id`).
It never contains the resolved email, name, or any decrypted value.

| HTTP  | When                                                    |
| ----- | ------------------------------------------------------- |
| `200` | job found and owned by the caller's org                 |
| `401` | auth as above                                           |
| `404` | unknown `job_id`, or the job belongs to a different org |

---

## 5. Placeholders (fixed allow-list, optional)

Placeholders are **optional**. If present in `subject` or `body_markdown`, they are
replaced per-recipient; if absent, the message is sent as-is. Only this fixed set
is supported in v1:

| Placeholder      | Resolved from (Signals decrypt `contact`)       | Notes                       |
| ---------------- | ----------------------------------------------- | --------------------------- |
| `{{name}}`       | `contact.name.value` (item → user fallback)     | Full name as stored         |
| `{{first_name}}` | first whitespace-delimited word of `name.value` | Convenience for greetings   |
| `{{email}}`      | `contact.email.value`                           | The recipient's own address |
| `{{phone}}`      | `contact.phone.value`                           |                             |

**Rules**

- **Syntax:** `{{token}}` (double-brace). Whitespace inside is tolerated
  (`{{ name }}`).
- **Unknown token → `400 UNKNOWN_PLACEHOLDER`** at submit time (fail-closed —
  catches typos like `{{Name}}` before any email is sent). `{{ … }}` is therefore
  reserved syntax in subject/body.
- **Missing value:** if a supported placeholder resolves to `null` (e.g. the
  participant has no name), it renders as an **empty string** — the send still
  happens. (Only a missing **email** skips the recipient.)
- **Decrypt is scoped to what's used:** we scan subject+body for placeholders and
  request only those contact fields (always `email`; `name`/`phone` only if
  referenced). No body placeholders → decrypt fetches just the email.

**Rendering & safety (order matters):**

1. Render `body_markdown` → HTML once (shared template, tokens still present).
2. **Sanitise** the HTML (strip scripts / event handlers / unsafe URLs).
3. Per recipient, substitute each `{{token}}` with the **HTML-escaped** value into
   the sanitised HTML (so a PII value can never inject markup), and into the raw
   Markdown for the plain-text part (raw value, no escaping needed).
4. Subject: substitute the raw value (plain-text header).

This keeps the template structure (author-controlled) separate from the values
(escaped), so decrypted PII cannot break out into HTML.

---

## 6. Body format (Markdown)

- Input is **Markdown** (`body_markdown`). We produce **both** MIME parts the
  mailer requires:
  - `html` = `sanitize(markdown_to_html(body))` with placeholders substituted.
  - `text` = the Markdown source with placeholders substituted (Markdown is
    human-readable as plain text).
- Basic formatting (bold, paragraphs/line-gaps, lists, links) renders in email
  clients from the generated HTML without inline styles.
- **New dependencies:** a Markdown renderer (`marked`) + an HTML sanitiser
  (`sanitize-html`). The repo currently has no templating/markdown deps; these are
  the only additions.

---

## 7. How it works, end to end

**Phase 1 — API (`apps/api`, synchronous):**

1. Authenticate + `azp` gate (campaign-manager only).
2. Derive `orgId` from the `signalstack_org_id` claim (`403` if absent).
3. Validate the body; **validate placeholders** against the allow-list
   (`400 UNKNOWN_PLACEHOLDER` on an unknown token).
4. Enqueue a durable `campaign-email` job carrying
   `{ orgId, itemIds, subject, bodyMarkdown, replyTo?, purpose?, requestId }`
   → return **`202 { job_id, status: "queued", requested }`**. The API never calls
   Signals or the mailer.

**Phase 2 — Worker (`apps/worker`, `email` role, asynchronous):** 5. **Decrypt** `item_ids` with `x-acting-org-id = orgId`, `fields: []`,
`contact:` the set of fields the template uses (always `email`). Signals returns
owned rows + `skipped[]` (unowned → `skipped_not_owned`). 6. **Render once** (markdown → HTML → sanitise). 7. **Per recipient:** resolve email (null → `skipped_no_email`); substitute
placeholders; `getMailer().send({ to, subject, html, text, replyTo? })`; record
the outcome (`sent` + `message_id`, or `failed` + reason). 8. **Write per-recipient results** into the job **result store** (Redis, keyed by
`job_id`, PII-free, TTL `EMAIL_RESULT_TTL_SECONDS`, default 24h) and mark the
job `done`. The poll endpoint reads this.

### Retry policy — **`attempts: 1`** (important, differs from the export)

Re-sending an email is user-visible (spam), so the email job must **not**
whole-job retry. It runs with `attempts: 1`: transient per-recipient failures are
recorded as `failed` (with the transport reason), and the **prototype re-requests
only the failed `item_ids`**. This trades auto-retry for guaranteed
no-duplicate-sends. (A future v2 could add a per-recipient idempotency store to
re-enable safe retries.) Bounded send concurrency (e.g. 5 at a time) keeps a large
batch from overwhelming the SMTP pool.

---

## 8. Configuration (new env)

| Env                            | Default            | Purpose                                                                |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| `EMAIL_MAX_RECIPIENTS`         | `200`              | Max `item_ids` per request; over → `400`.                              |
| `EMAIL_RESULT_TTL_SECONDS`     | `86400`            | How long per-recipient results are retained for polling.               |
| `EMAIL_SEND_CONCURRENCY`       | `5`                | Parallel sends per job.                                                |
| `CAMPAIGN_MANAGER_ALLOWED_AZP` | `campaign-manager` | **Reused** from the export — the client(s) allowed on campaign routes. |

Mailer env (`MAIL_PROVIDER`/`SMTP_*`/`SES_*`) is already wired on the worker (added
for the export). The worker gains a new `email` role (`WORKER_ROLES`).

---

## 9. Implementation plan (mirrors the export)

- `packages/queue` — `QueueName.CampaignEmail`, `CampaignEmailJob` type.
- `apps/api/src/routes/campaign-email.ts` — the two routes; reuse `requireAuth`
  (azp gate) + placeholder validation.
- `apps/api/src/services/campaign-email-queue/` — enqueue + close (lazy singletons).
- `apps/api/src/services/campaign-email-results/` — Redis result store
  (read on poll; org-scoped).
- `apps/worker` — new `email` role in `worker-roles.ts` + `main.ts`;
  `jobs/campaign-email-process.ts` (wiring) + `services/campaign-email/index.ts`
  (`runEmailsend`, injected deps).
- `packages/` — a small `markdown-email` helper (render + sanitise + substitute),
  or inline in the worker service; add `marked` + `sanitize-html`.
- Tests + `openapi.json` regen.

---

## 10. Open decisions (please confirm)

1. **Unknown-placeholder = `400`** (fail-closed) vs leave the literal `{{token}}`
   in the text. Spec assumes **`400`**.
2. **`EMAIL_MAX_RECIPIENTS = 200`** and **`attempts: 1`** — confirm the cap and the
   no-retry-per-job policy.
3. **Consent** deferred to v2 — confirm not gating sends now.
4. **`From` address** = the aggregator's configured sender (`SMTP_FROM`/`SES_FROM`);
   only `Reply-To` is caller-settable — confirm.
