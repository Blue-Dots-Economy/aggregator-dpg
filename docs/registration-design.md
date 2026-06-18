# Aggregator Registration Design

**Audience:** Developers and product team members who need to understand how a new aggregator organisation applies to join the Blue Dots network, from first form submission through account activation.

---

## Contents

1. [What this document covers](#1-what-this-document-covers)
2. [Problems the new design solves](#2-problems-the-new-design-solves)
3. [Functional flow — end to end](#3-functional-flow--end-to-end)
4. [State machine (FSM)](#4-state-machine-fsm)
5. [Data model](#5-data-model)
6. [Approval token mechanism](#6-approval-token-mechanism)
7. [Inline provisioning and the reconciler](#7-inline-provisioning-and-the-reconciler)
8. [Provisioning steps reference](#8-provisioning-steps-reference)
9. [API reference](#9-api-reference)
10. [Configuration reference](#10-configuration-reference)
11. [Key design decisions](#11-key-design-decisions)

---

## 1. What this document covers

An **aggregator** is an organisation that onboards participants (job-seekers or service providers) into the Blue Dots network. Before an aggregator can use the portal to manage participants, the organisation must apply and be approved.

The registration subsystem handles the full lifecycle:

- Form submission by the applicant
- Email verification to confirm the contact address
- Admin review and approve/reject decision
- Account provisioning (Keycloak user, Signals-DPG organisation, welcome notification)
- Convergence guarantee if any provisioning step fails mid-way

---

## 2. Problems the new design solves

### 2.1 No lost registrations on partial failures

**Old approach:** Submit → immediately create Keycloak user + call external APIs inline → if any step failed, the registration was silently incomplete with no way to retry.

**New approach:** Registration is a durable database row. Every external step (email send, Keycloak call, Signals-DPG push) is idempotent and tracked in `provision_state`. The reconciler can re-run any failed step without risk of duplication.

### 2.2 No duplicate-submission attacks

**Old approach:** Submitting the same form twice created two rows and two Keycloak users.

**New approach:** The submit endpoint computes a deterministic SHA-256 fingerprint from `email + phone + orgName`. A second identical submission finds the existing row and replays the `202 Accepted` without creating any new records.

### 2.3 No existence oracle

**Old approach:** A 409 Conflict on a duplicate email revealed whether that email was already registered — a privacy leak.

**New approach:** All submit outcomes (new, replay, duplicate email/phone) return a uniform `202 Accepted`. The applicant is told "check your email" regardless. The form cannot be used to probe which email addresses are in the system.

### 2.4 No concurrent-write corruption

**Old approach:** Concurrent requests on the same registration row could overwrite each other's state without detection.

**New approach:** Every state transition uses optimistic locking (`version` counter + compare-and-set). A stale write returns `STALE_TRANSITION`; callers treat this as a no-op (the concurrent writer already made the correct change).

### 2.5 Full audit trail

Every state transition — who triggered it, from which state to which state, and why — is recorded in the `registration_transitions` table. Admins can see the complete history of any application.

### 2.6 Idempotent admin actions

**Old approach:** An admin clicking an approval link twice could trigger double-provisioning.

**New approach:** Approval/rejection is guarded by compare-and-set. The second click detects that the state is already `approved` or `rejected` and renders an "already decided" page.

---

## 3. Functional flow — end to end

```
Applicant                API (BFF)               Admin email          Reconciler
─────────                ─────────               ───────────          ──────────
 Fill form
     │
     ▼
POST /v1/aggregator-registrations/create
     │  ── validate, deduplicate, rate-limit ──▶
     │  ◀── 202 Accepted (always) ──────────────
     │
     │  (best-effort inline)
     │  API sends verification email ──────────────────────────────▶ applicant inbox
     │                                                                   │
     │                                                               Click link
     │                                                                   │
     ◀─────── GET /register/verify?id=...&token=... ────────────────────
     │
POST /v1/aggregator-registrations/:id/verify?token=...
     │  ── verify JWT, CAS submitted→verified ──▶
     │  ◀── 200 {verified: true} ───────────────
     │
     │  (best-effort inline)
     │  API sends admin notification ───────────────────────────────▶ admin inbox
     │                                                                   │
     │                                                               Click [Approve] or [Reject]
     │                                                                   │
     ▼                                                                   ▼
GET /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve
     │  ── render confirmation HTML page ──────────────────────────▶ admin browser
     │                                                                   │
     │                                                               Click Confirm
     │                                                                   │
POST /admin/v1/aggregator-registrations/decision/:id
     │  ── verify JWT, CAS verified→approved/rejected ──▶
     │  ◀── HTML result page ───────────────────────────
     │
     │  (best-effort inline, fire-and-forget)
     │  ensureGraduated  → creates aggregators row, transitions approved→active
     │  ensureKeycloakUser → creates KC user
     │  ensureSignalstackOrg → upserts org in Signals-DPG
     │  ensureWelcomeSent → emails applicant
     │     (or for rejection: ensureRejectionSent)
     │
     │  If any inline step fails ─────────────────────────────────▶ Reconciler retries on next tick
```

### What the applicant sees

1. Fill and submit the registration form.
2. Receive a verification email — click the link within the TTL window (default 60 min).
3. Wait for admin review (typically within a few business days).
4. Receive a welcome email with portal login instructions once approved.

### What the admin sees

1. Receive a notification email listing organisation name, contact details, and two links: **Approve** and **Reject**.
2. Click a link → browser opens a confirmation page showing the application details.
3. Click the confirm button on that page → decision is recorded and provisioning begins.
4. No login required — the email link carries a signed JWT that authorises the single action.

---

## 4. State machine (FSM)

```
                     ┌─────────────────────────────────┐
                     │           submitted               │  ← created on form submit
                     └─────────────────────────────────┘
                           │                      │
              applicant clicks               unverified TTL
              verification link              exceeded (72 h)
                           │                      │
                           ▼                      ▼
                     ┌──────────┐         ┌────────────┐
                     │ verified │         │ abandoned  │  ← terminal
                     └──────────┘         └────────────┘
                     │          │
              admin clicks   admin clicks
              Approve         Reject
                     │          │
                     ▼          ▼
              ┌──────────┐  ┌──────────┐
              │ approved │  │ rejected │  ← terminal (rejected)
              └──────────┘  └──────────┘
                     │
           stuck TTL exceeded (168 h)    OR    graduation succeeds
                     │                                  │
                     ▼                                  ▼
              ┌────────────┐                    ┌────────────┐
              │ abandoned  │                    │   active   │  ← terminal (operational)
              └────────────┘                    └────────────┘
```

### State descriptions

| State       | Who sets it                      | Description                                                |
| ----------- | -------------------------------- | ---------------------------------------------------------- |
| `submitted` | API on form submit               | Application received; waiting for email verification.      |
| `verified`  | Applicant via verification link  | Email confirmed; waiting for admin decision.               |
| `approved`  | Admin via approval email         | Admin approved; provisioning in progress.                  |
| `active`    | Reconciler / inline provisioning | Aggregator row created; account fully operational.         |
| `rejected`  | Admin via approval email         | Application not approved; rejection email sent.            |
| `abandoned` | Reconciler on TTL expiry         | Unverified for 72 h, or stuck verified/approved for 168 h. |

### Terminal states

`active`, `rejected`, and `abandoned` are terminal — no further transitions occur. When a registration is `rejected` or `abandoned`, the unique constraint on `contact_email` and `contact_phone` is released so the same applicant can re-register.

### Actors

| Actor        | Role                                                             |
| ------------ | ---------------------------------------------------------------- |
| `applicant`  | Submits the form; clicks the verification link                   |
| `admin`      | Makes approve/reject decision via email link                     |
| `reconciler` | Background process that retries failed steps; handles TTL expiry |
| `system`     | Internal operations (graduation, provisioning)                   |

---

## 5. Data model

### `registrations` table

The single source of truth for an application's lifecycle.

| Column                  | Type          | Description                                                  |
| ----------------------- | ------------- | ------------------------------------------------------------ | ----- | ---------------------------------- |
| `id`                    | UUID          | Primary key                                                  |
| `idempotency_key`       | text (unique) | SHA-256 of `email                                            | phone | orgName` — prevents duplicate rows |
| `state`                 | enum          | FSM state (`submitted` → `verified` → `approved` → `active`) |
| `contact_email`         | text          | Applicant email (lowercased)                                 |
| `contact_phone`         | text          | E.164 normalised phone number                                |
| `org_name`              | text          | Organisation name                                            |
| `org_type`              | text          | Type (e.g. `aggregator`)                                     |
| `org_url`               | text          | Optional website                                             |
| `org_locations`         | jsonb         | Operational locations                                        |
| `profile_draft`         | jsonb         | Full form payload for downstream provisioning                |
| `consent`               | jsonb         | Server-stamped consent record with `given_at` / `valid_till` |
| `idp_user_id`           | text          | Keycloak user ID — set after KC account created              |
| `signalstack_org_id`    | text          | Signals-DPG org ID — set after upsert                        |
| `aggregator_id`         | UUID (FK)     | Links to `aggregators` row — set at graduation               |
| `verification_sent_at`  | timestamp     | Last time verification email was sent                        |
| `verified_at`           | timestamp     | When applicant clicked the verification link                 |
| `admin_notified_at`     | timestamp     | Last time admin notification was sent                        |
| `provision_state`       | jsonb         | Per-step `done` / `failed` flags (see below)                 |
| `version`               | integer       | Optimistic-lock counter; incremented on every transition     |
| `reconciler_claimed_at` | timestamp     | Lock held by an active reconciler tick                       |

### `provision_state` keys

This JSONB column tracks the completion of each provisioning side-effect independently. Each key is either `'done'` or `'failed'`.

| Key            | Step                                               | Triggered by                                  |
| -------------- | -------------------------------------------------- | --------------------------------------------- |
| `verification` | Verification email sent to applicant               | Submit (inline) or reconciler                 |
| `admin_notify` | Admin notification email with approve/reject links | Verify (inline) or reconciler                 |
| `graduated`    | `aggregators` row created; `approved → active`     | Approval (inline) or reconciler               |
| `kc_user`      | Keycloak user account created                      | Approval (inline) — not retried by reconciler |
| `ss_org`       | Signals-DPG org upsert                             | Approval (inline) or reconciler               |
| `welcome`      | Welcome email sent to applicant                    | Approval (inline) or reconciler               |
| `rejection`    | Rejection email sent to applicant                  | Rejection (inline) or reconciler              |

### `registration_transitions` table

Immutable audit log — one row per state change.

| Column            | Type      | Description                                                   |
| ----------------- | --------- | ------------------------------------------------------------- |
| `registration_id` | UUID (FK) | Parent registration                                           |
| `from_state`      | enum      | Previous state                                                |
| `to_state`        | enum      | New state                                                     |
| `actor`           | enum      | Who triggered it                                              |
| `reason`          | text      | Human-readable reason (e.g. `email_verification`, `approval`) |
| `at`              | timestamp | When the transition occurred                                  |

### `aggregators` table

The live aggregator identity record — created at graduation (the `approved → active` transition).

Linked from `registrations.aggregator_id` after graduation.

---

## 6. Approval token mechanism

All email links carry a signed JWT. No database lookup is needed to authorise an action — the token is self-contained.

### Verification token (applicant → API)

Sent in the verification email. Carries:

- `sub`: registration ID
- `intent`: `"verify"`
- `aud`: `"aggregator-applicant"`
- Expiry: configurable (default 60 min)

The verify endpoint checks the signature, confirms `sub` matches the URL path parameter, then does a CAS `submitted → verified`.

### Approval token (admin → API)

Two tokens per notification email — one for approve, one for reject. Each carries:

- `sub`: registration ID
- `intent`: `"approve"` or `"reject"`
- `aud`: `"aggregator-admin"`
- Expiry: 7 days (so the admin has time to act)

Both tokens are signed with the same secret (`APPROVAL_TOKEN_SECRET`) using HS256. The decision endpoint re-checks the current FSM state before acting, so a replayed or expired token never produces a duplicate effect.

### Idempotency of the admin link

The confirmation page renders an "already decided" view if the registration is already in `approved`, `active`, `rejected`, or `abandoned`. The admin can click their email links multiple times safely.

---

## 7. Inline provisioning and the reconciler

### Design principle: write first, side-effect second

When the API receives a submit or a decision, it first writes the state change to the database in a single atomic operation. Only then does it attempt the side-effects (emails, Keycloak calls, Signals-DPG pushes).

This means **the row is always consistent even if all the external calls fail**. The reconciler can look at the row, see which steps haven't completed (via `provision_state`), and retry them.

### Inline vs. reconciler

| Path                     | How it runs                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inline (best-effort)** | The API fires off provisioning steps immediately after committing the state change. These are best-effort — a failure is logged as a warning but the HTTP response is already sent. |
| **Reconciler**           | On-demand repair pass triggered by an admin API call. Claims all non-terminal rows atomically, retries all incomplete steps, releases claims.                                       |

The inline path exists for latency (most applications succeed immediately and the applicant/admin gets fast feedback). The reconciler exists for correctness (failures are never permanent).

### Claim locking

When the reconciler starts processing a row, it sets `reconciler_claimed_at = now()`. This prevents two concurrent reconciler ticks from processing the same row simultaneously. Claims expire after 10 minutes — a crashed reconciler tick will not permanently lock rows.

### TTL abandonment

The reconciler also handles timeout cases:

- **Unverified TTL (72 h):** A `submitted` row that has not progressed to `verified` within 72 hours is moved to `abandoned`. The applicant never clicked their verification link.
- **Stuck TTL (168 h):** A `verified` or `approved` row that has not progressed within 168 hours (7 days) is moved to `abandoned`. This catches cases where provisioning repeatedly fails and no human intervened.

### Keycloak user creation

`kc_user` is the one step the reconciler does **not** retry automatically. Creating a Keycloak user requires a synchronous exchange with Keycloak and carries risk of partial state if retried without care. If this step fails, the reconciler logs a warning with `kc_user_not_created_needs_admin`. An operator must trigger a manual repair via the admin portal or the `reconcile/by-contact` endpoint.

### Triggering the reconciler

The reconciler runs **on demand only** — it has no automatic scheduler in the current implementation. Operators trigger it via:

```
POST /admin/v1/aggregator/registration/reconcile
```

or repair a single application by contact:

```
POST /admin/v1/aggregator/registration/reconcile/by-contact
{ "email": "contact@example.org" }
```

> **Note for operators:** Until a scheduled heartbeat is added, registrations with failed provisioning steps will remain stuck until an operator manually triggers reconciliation. The improvement plan tracks adding a BullMQ repeatable job as a P0 item.

---

## 8. Provisioning steps reference

Each step is implemented as an `ensure-*` function in `apps/api/src/services/registration-provisioning/`. All steps are idempotent — running a step that has already succeeded is a safe no-op.

### `ensureVerificationSent`

- **Triggered:** After form submit.
- **What it does:** Mints a verification JWT, builds the verify URL (`/register/verify?id=...&token=...`), sends the email.
- **Guard:** Skips if `provision_state.verification === 'done'`; respects a resend cooldown (default 60 min).

### `ensureAdminNotified`

- **Triggered:** After email verification.
- **What it does:** Mints two approval JWTs (approve + reject), builds the admin HTML email with both links, sends to all configured `ADMIN_EMAILS`.
- **Guard:** Skips if `provision_state.admin_notify === 'done'`; respects resend cooldown.

### `ensureGraduated`

- **Triggered:** After admin approval.
- **What it does:** Inserts a row into `aggregators` (the live identity table), inserts a matching `aggregator_profile` row, and performs a CAS `approved → active` transition writing the new `aggregator_id`.
- **Slug generation:** `orgName` is slugified + a 4-character random hex suffix to avoid conflicts.
- **Guard:** Skips if `provision_state.graduated === 'done'`.

### `ensureKeycloakUser`

- **Triggered:** After approval (and graduation).
- **What it does:** Creates a Keycloak user in the `aggregator` realm with `aggregator_id` and `phone_number` user attributes. Sets a temporary password and flags `required_actions: [UPDATE_PASSWORD]`.
- **Guard:** Skips if `provision_state.kc_user === 'done'`. Not retried by reconciler — requires manual intervention on failure.

### `ensureSignalstackOrg`

- **Triggered:** After graduation (needs the `aggregator_id` FK).
- **What it does:** Calls `signalStackWriter.upsertAggregator` to register the organisation in Signals-DPG. Stores the returned `ss_org_id` on both the registration row and the aggregators row.
- **Guard:** Skips if `provision_state.ss_org === 'done'`.

### `ensureWelcomeSent`

- **Triggered:** After approval provisioning completes.
- **What it does:** Sends a welcome email to the applicant with a link to the portal.
- **Guard:** Skips if `provision_state.welcome === 'done'`.

### `ensureRejectionSent`

- **Triggered:** After admin rejection.
- **What it does:** Sends a rejection notification to the applicant.
- **Guard:** Skips if `provision_state.rejection === 'done'`.

### `ensureKeycloakUserDisabled`

- **Triggered:** After admin rejection.
- **What it does:** Disables the Keycloak user (if one was created) to prevent any issued tokens from working.

---

## 9. API reference

All endpoints live in `apps/api` (Fastify on port 4000).

### Public endpoints (accessible by the web portal's service account)

#### `POST /v1/aggregator-registrations/create`

Submit a new registration application.

**Auth:** Service-account bearer token (Keycloak `client_credentials` from `aggregator-bff`).

**Request body:**

```json
{
  "name": "My NGO",
  "type": "aggregator",
  "url": "https://myngo.org",
  "contact": {
    "email": "contact@myngo.org",
    "phone": "+919876543210"
  },
  "locations": [...],
  "consent": {
    "version": "1.0",
    "given_at": "...",
    "valid_till": "..."
  }
}
```

**Response:** Always `202 Accepted` — for new, duplicate, or idempotency-replay submissions.

**Rate limit:** Per `email:IP` combination — configurable via `PUBLIC_SUBMIT_RATE_WINDOW_SECONDS` / `PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW`.

---

#### `POST /v1/aggregator-registrations/:id/verify`

Verify the applicant's email address. Called when the applicant clicks the link in their verification email.

**Query parameter:** `token` — signed verification JWT.

**Response:** `200 { verified: true }` on success. Idempotent — returns 200 if already verified.

---

### Admin endpoints (protected by gateway path policy on `/admin/**`)

> The application itself does not check admin credentials. An API gateway (Kong, Keycloak token exchange, etc.) must enforce authentication for all requests matching `/admin/**`. See `apps/api/src/routes/aggregator-registrations-admin.ts` for the rationale.

#### `GET /admin/v1/aggregator-registrations/read/:id?token=...&intent=approve|reject`

Renders an HTML confirmation page for an approve or reject action. The `token` is the approval JWT from the admin notification email. Shows "already decided" if the registration is past the decision point.

#### `POST /admin/v1/aggregator-registrations/decision/:id`

Records an approve or reject decision and fires provisioning.

**Body:** `{ token, decision: "approve" | "reject", reason? }`

**Response:** HTML result page.

---

#### `GET /admin/v1/aggregator/registration`

Lists registrations with pagination and optional state filter.

**Query params:** `state`, `page`, `limit`, `sort` (`created_at` | `updated_at`), `order` (`asc` | `desc`).

#### `GET /admin/v1/aggregator/registration/:id`

Returns a single registration with its full transition history.

#### `POST /admin/v1/aggregator/registration/reconcile`

Runs a full reconciler tick over all non-terminal registrations. Returns a `ReconcileOutcome` with per-category counts.

#### `POST /admin/v1/aggregator/registration/reconcile/by-contact`

Runs the reconciler for a single registration identified by email or phone. Useful for manually repairing a stuck application.

**Body:** `{ email?: string, phone?: string }` — provide one.

---

## 10. Configuration reference

All values are environment variables read by `apps/api/src/config.ts`.

| Variable                                | Default                 | Description                                                                |
| --------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `APPROVAL_TOKEN_SECRET`                 | —                       | **Required.** HS256 signing secret for all JWTs. Must be ≥ 32 characters.  |
| `ADMIN_EMAILS`                          | `""`                    | Comma-separated list of admin email addresses for review notifications.    |
| `PUBLIC_API_URL`                        | `http://localhost:4000` | Base URL of the API — used to build admin email links.                     |
| `PUBLIC_PORTAL_URL`                     | `http://localhost:3000` | Base URL of the web portal — used to build verification and welcome links. |
| `REGISTRATION_VERIFICATION_TTL_MINUTES` | `60`                    | Verification email link validity.                                          |
| `REGISTRATION_RESEND_COOLDOWN_MINUTES`  | `60`                    | Minimum gap between repeated email sends (all types).                      |
| `REGISTRATION_UNVERIFIED_TTL_HOURS`     | `72`                    | Hours before an unverified `submitted` row is abandoned.                   |
| `REGISTRATION_STUCK_TTL_HOURS`          | `168`                   | Hours before a stuck `verified` or `approved` row is abandoned.            |
| `PUBLIC_SUBMIT_RATE_WINDOW_SECONDS`     | —                       | Rate-limit window for the submit endpoint.                                 |
| `PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW`     | —                       | Max submissions per email:IP pair within the window.                       |

---

## 11. Key design decisions

### Single atomic write on submit

The submit endpoint does exactly one database write: `INSERT INTO registrations`. There are no external calls in the write path. This keeps the endpoint latency low, eliminates partial-failure states at submit time, and makes the row the single source of truth regardless of what happens next.

### Uniform 202 on submit

Returning the same status code for new, duplicate, idempotency-replay, and duplicate-contact cases ensures the endpoint cannot be used to probe the database. An attacker cannot determine whether a given email is already registered by observing the HTTP response code or timing.

### Compare-and-set on every transition

The `version` column acts as an optimistic lock. Any state change reads the current version, includes it in the `WHERE` clause of the update, and fails with `STALE_TRANSITION` if the row was modified concurrently. Callers treat a stale transition as a success (the concurrent writer already made the correct change). This eliminates the need for advisory DB locks and keeps the code correct under concurrent load.

### Token-based admin flow (no login required)

Admins receive clickable links directly in their email. The links carry a signed JWT that authorises exactly one action on one registration. This avoids the friction of requiring admins to log into a separate dashboard for the common case. A gateway enforces route-level auth on `/admin/**` for any API calls that require session context.

### `provision_state` as a per-step tracker

Externalising side-effect completion into a JSONB column means any step can fail independently without rolling back others. The reconciler only retries the specific steps that are not marked `done`. This is simpler than a saga coordinator and sufficient for the current scale.

### Inline provisioning as an optimisation

The API fires provisioning steps immediately after committing the state change. This is a latency optimisation — in the happy path the applicant gets their verification email within seconds and the admin gets their notification immediately. The reconciler is the correctness guarantee, not the primary execution path.

### Keycloak user creation is not auto-retried

Creating a KC user carries risk of partial state (user created in KC but not linked back to the row). The reconciler currently logs KC failures as warnings requiring manual intervention. This is a deliberate conservative choice for MVP; automatic retry with proper idempotency checking is tracked in the improvement plan.

### Admin path prefix for gateway policy

All admin endpoints sit under `/admin/v1/`. This convention lets a single API gateway rule (e.g. `path_prefix: /admin`) apply authentication policy without enumerating individual routes. The application trusts that only authenticated admin traffic reaches these handlers.
