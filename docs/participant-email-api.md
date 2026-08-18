# Participant Email API (campaign-manager) — Design Spec

**Ticket:** aggregator-dpg#578 · **Umbrella:** Blue-Dots-Economy/signals-dpg#237
**Status:** Draft spec (pre-implementation) · **Branch:** `feat/578-participant-email`

---

## 1. What this is

The campaign-manager application needs to **email participants that its
organisation owns** (e.g. follow-ups). The campaign author composes one message —
a **subject** and a **Markdown body**, optionally with a few **placeholders**
(`{{name}}`, …) — and sends the aggregator a list of **participant references**
(profile item ids). The campaign-manager never sends, and never sees, any email
address.

The aggregator resolves each participant's email **on the server** (from the
encrypted participant store), personalises the message per recipient, and sends
it. The request is **asynchronous**: the API validates the request and queues the
work, and a background worker performs the decrypt + send.

**Personal data never leaves the aggregator.** The caller sends only item ids;
the resolved email addresses (and any other personal fields) are used solely to
build and send the emails, and are never returned to the caller or written to any
caller-visible surface.

---

## 2. Scope (v1)

- **One endpoint.** `POST /v1/campaign/email` validates the request and **queues**
  it, returning `202 { status: "queued" }`. A background worker then decrypts the
  recipients and sends the emails.
- **One shared message**, sent to N owned participants.
- **Optional placeholders** — if the subject/body contains a supported placeholder
  it is replaced with that participant's value; if there are none, the same
  message is sent to everyone. Placeholders are **not** required.
- **Markdown body** → rendered to HTML + a plain-text fallback, sanitised.
- **Missing email** → that recipient is skipped (logged); it never fails the batch.

**Deferred to v2 (explicitly out of scope now):**

- A **status/reporting** channel back to the caller — a returned `job_id` plus a
  `GET /v1/campaign/email/{job_id}` poll endpoint that reports **per-recipient**
  outcomes (sent / skipped / failed). In v1 the worker performs the send and
  records outcomes in its own structured logs only.
- Email-contact **consent** gating.
- **Profile-field** placeholders beyond the fixed identity set in §5 (see §5.1).
- Attachments; scheduled/delayed send.

---

## 3. Authentication & authorization

**Token.** Every request carries `Authorization: Bearer <token>` — a Keycloak
access token issued to the campaign-manager application when a campaign-manager
user logs in (interactive OIDC login; the client holds no secret). The token
identifies both the **user** and, via custom claims, the **organisation** they act
for.

**Client scoping (who may call this API).** The endpoint accepts a token **only
if** the token's `azp` claim (the Keycloak client that requested it) is in the
allow-list `CAMPAIGN_MANAGER_ALLOWED_AZP` (default: `campaign-manager`). Tokens
from any other client are rejected with `401`. This client is intentionally kept
out of the aggregator's general token allow-list, so a campaign-manager token is
**only** usable on the campaign endpoints and nowhere else in the aggregator.

**Organisation identity.** The acting organisation is read from the token's
`signalstack_org_id` claim — it is **never** taken from a request header or body.
A token without that claim is rejected with `403`.

**Ownership (which participants a caller may email).** Ownership is enforced by
the participant store: the decrypt call is scoped to the caller's organisation, so
it returns data **only** for participants that organisation onboarded. Any
requested `item_id` the organisation does not own is silently dropped from the
send (and logged). A caller therefore cannot email participants belonging to
another organisation, even by guessing ids.

---

## 4. API

### `POST /v1/campaign/email`

Validates the request and **queues** it for asynchronous sending. Returns `202`
once the job is durably queued. No personal data is present in the request or the
response.

**Request body** (`application/json`, strict — unknown keys are rejected):

| Field           | Type              | Required | Notes                                                                                                                                           |
| --------------- | ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_ids`      | `string[]` (UUID) | yes      | The participant references to email. 1 … `EMAIL_MAX_RECIPIENTS` (default 200). Over the cap → `400` (the request is rejected, never truncated). |
| `subject`       | `string`          | yes      | ≤ 200 chars. Plain text. May contain placeholders (§5).                                                                                         |
| `body_markdown` | `string`          | yes      | ≤ 20 000 chars. Markdown. May contain placeholders (§5). Rendered on the server.                                                                |
| `reply_to`      | `string` (email)  | no       | Sets the email `Reply-To`. The `From` address is always the aggregator's configured sender.                                                     |
| `purpose`       | `string`          | no       | ≤ 500 chars. Recorded for audit only; never emailed.                                                                                            |

**Example request**

```jsonc
POST /v1/campaign/email
Authorization: Bearer <campaign-manager access token>
Content-Type: application/json
{
  "item_ids": [
    "e4e163e7-c4ad-42f9-9550-af6f09267e14",
    "13ccd407-9965-44ff-9d04-2a1561c4f740"
  ],
  "subject": "Hi {{first_name}}, an update on your application",
  "body_markdown": "Hi {{name}},\n\nWe have an **update** for you:\n\n- Step one is complete\n- Step two starts next week\n\nThanks!",
  "reply_to": "campaign@org.example",
  "purpose": "Q3 follow-up"
}
```

**Success — `202 Accepted`**

```json
{
  "status": "queued",
  "requested": 2,
  "message": "Your campaign email has been queued and will be sent to the resolved participants shortly."
}
```

> `202` means the job is **durably queued** — not that the emails have been sent.
> Decrypt + send happen asynchronously in the worker. (Per-recipient delivery
> status is a v2 feature — see §2.)

**Error responses**

| HTTP  | `error.code`           | When                                                                                                                                                      |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400` | `SCHEMA_VALIDATION`    | Malformed body: non-UUID / empty / over-cap `item_ids`, missing `subject`/`body_markdown`, or unknown keys.                                               |
| `400` | `UNKNOWN_PLACEHOLDER`  | The subject or body contains a `{{token}}` that is not in the supported set (§5). Fail-closed, so a typo never ships to real inboxes.                     |
| `401` | `UNAUTHORIZED`         | Token missing / malformed / bad signature or expiry, **or** the token's `azp` is not an allowed campaign-manager client.                                  |
| `403` | `FORBIDDEN`            | Token is valid but lacks the organisation claim (`MISSING_SIGNALSTACK_ORG`) or the aggregator claim (`MISSING_AGGREGATOR_ID`).                            |
| `503` | `EMAIL_ENQUEUE_FAILED` | The job could not be queued (e.g. the queue backend is unreachable). A `202` must mean durably queued, so this is surfaced rather than silently accepted. |

---

## 5. Placeholders (fixed set, optional)

Placeholders let the campaign author personalise the message. They are
**optional**: if the subject/body contains one it is replaced per recipient; if it
contains none, the identical message is sent to everyone.

**Supported placeholders (v1)** — all resolved from the participant's stored
contact identity:

| Placeholder      | Value                                           |
| ---------------- | ----------------------------------------------- |
| `{{name}}`       | The participant's full name.                    |
| `{{first_name}}` | The first word of the name (for greetings).     |
| `{{last_name}}`  | The remainder of the name after the first word. |
| `{{email}}`      | The participant's own email address.            |
| `{{phone}}`      | The participant's phone number.                 |

**Rules**

- **Syntax:** `{{token}}` (double curly braces). Surrounding whitespace is
  tolerated: `{{ name }}` works.
- **Unknown token → `400 UNKNOWN_PLACEHOLDER`** at submit time (before anything is
  sent), naming the offending token. This catches typos like `{{Name}}` early.
  `{{ … }}` is therefore reserved syntax in the subject and body.
- **Missing value:** if a supported placeholder has no value for a participant
  (e.g. no name on file), it renders as an **empty string** — the email is still
  sent. Only a missing **email address** causes that recipient to be skipped.
- **Minimal data access:** the server only decrypts the fields the message
  actually uses. The recipient email is always needed; `name`/`phone` are decrypted
  only if the corresponding placeholder appears.

**Rendering & safety**

1. The Markdown body is rendered to HTML **once** (the template is shared).
2. The HTML is **sanitised** (scripts, event handlers, and unsafe URLs stripped).
3. For each recipient, each `{{token}}` is replaced with the participant's value —
   **HTML-escaped** in the HTML part (so a value can never inject markup) and used
   verbatim in the plain-text part.

The message structure is author-controlled; the substituted personal values are
always escaped, so decrypted data cannot alter the message structure.

### 5.1 Extra (profile) placeholders — needs input

Anything beyond the identity fields above (e.g. `{{location}}`, `{{program}}` /
applied role, `{{reference_id}}`, `{{status}}`, a date) lives in the participant's
**profile**, and those field names **differ between participant types / networks**.
To avoid exposing arbitrary personal data, these are **not** supported by a generic
mechanism. Instead:

> **Campaign team, please tell us the exact extra fields your emails need.** We
> will add each as a **named, curated placeholder** mapped to the correct profile
> field per participant type (a small config change), rather than allowing free
> access to any field. This is planned as a fast follow (v2) once the list is
> known. If the emails only need greetings, the identity set above is sufficient.

---

## 6. Body format (Markdown)

- The body is submitted as **Markdown** (`body_markdown`). The server produces the
  two parts an email needs:
  - **HTML part** = sanitised HTML rendered from the Markdown, with placeholders
    substituted.
  - **Plain-text part** = the Markdown source with placeholders substituted (it is
    already human-readable).
- Basic formatting — **bold**, paragraphs / blank-line spacing, bulleted lists,
  and links — renders correctly in email clients from the generated HTML.
- Implementation note: rendering + sanitising Markdown requires two small,
  standard libraries (a Markdown renderer and an HTML sanitiser); the codebase has
  no such dependency today.

---

## 7. How it works, end to end

**Phase 1 — API (synchronous, returns `202`):**

1. Authenticate the token and enforce the campaign-manager client gate (§3).
2. Read the acting organisation from the token's `signalstack_org_id` claim
   (`403` if absent).
3. Validate the body, and validate every placeholder in the subject/body against
   the supported set (`400 UNKNOWN_PLACEHOLDER` on an unknown token).
4. **Queue** a durable `campaign-email` job carrying the organisation id, item ids,
   subject, Markdown body, optional `reply_to`/`purpose`, and a request id.
   Return **`202 { status: "queued", requested }`**. The API itself never decrypts
   or sends.

**Phase 2 — Worker (asynchronous, after the `202`):** 5. **Decrypt** the requested participants, **scoped to the acting organisation** so
only owned participants resolve (unowned ids are dropped and logged). Only the
contact fields the message uses are requested. 6. **Render** the Markdown → sanitised HTML once. 7. **Per recipient:** resolve the email (no email → skip + log); substitute
placeholders; send via the aggregator's mailer (SES/SMTP). Sends run with a
small bounded concurrency so a large batch does not overwhelm the mail
transport. 8. Record each outcome (sent / skipped-no-email / skipped-not-owned / failed) in
structured logs. **No personal data is logged.**

### Send-once policy (important)

Re-sending an email is user-visible, so the job **does not retry as a whole**
(`attempts: 1`). A transient send failure for a recipient is logged as failed
rather than retried, which guarantees **no duplicate emails**. (v2 will add
per-recipient delivery reporting and, with it, safe per-recipient retries.)

---

## 8. Configuration (new settings)

| Setting                        | Default            | Purpose                                                     |
| ------------------------------ | ------------------ | ----------------------------------------------------------- |
| `EMAIL_MAX_RECIPIENTS`         | `200`              | Maximum `item_ids` per request; exceeding it → `400`.       |
| `EMAIL_SEND_CONCURRENCY`       | `5`                | Number of emails sent in parallel per job.                  |
| `CAMPAIGN_MANAGER_ALLOWED_AZP` | `campaign-manager` | The Keycloak client(s) permitted on the campaign endpoints. |

The mail transport (`MAIL_PROVIDER` + `SMTP_*` / `SES_*`) and the queue backend are
already configured for the aggregator's background worker.

---

## 9. Acceptance (v1)

- Emails are sent only to participants the caller's organisation owns; ids it does
  not own are dropped.
- A participant with no email address is skipped without failing the batch.
- The message is rendered on the server; the campaign-manager never receives any
  email address or other personal data.
- A campaign-manager token cannot reach any other aggregator endpoint, and no
  other client can reach this one.

---

## 10. Open decisions (please confirm)

1. **Unknown placeholder → `400`** (fail-closed) vs. leaving the literal
   `{{token}}` in the text. Spec assumes **`400`**.
2. **`EMAIL_MAX_RECIPIENTS = 200`** and the **send-once (`attempts: 1`)** policy —
   confirm the cap and the no-duplicate-sends trade-off.
3. **v1 placeholder set** = `name` / `first_name` / `last_name` / `email` /
   `phone`. Any extra **profile** fields the emails need (see §5.1) — list them, or
   confirm "identity only for v1".
4. **`From`** = the aggregator's configured sender; only `Reply-To` is caller-set —
   confirm.
5. **v2 status reporting** — confirm that returning per-recipient delivery status
   (`job_id` + poll endpoint) is acceptable as a fast follow rather than in v1.
