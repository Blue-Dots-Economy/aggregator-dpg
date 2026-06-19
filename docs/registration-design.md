# Aggregator Registration Design

**Audience:** Product team, developers, and operators who need to understand how a new aggregator organisation joins the Blue Dots network — from first form submission through account activation.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Data Model](#5-data-model)
6. [API Spec](#6-api-spec)
7. [Summary](#7-summary)

---

## 1. Introduction

This document describes the design of the **aggregator registration subsystem** in the Blue Dots platform.

An **aggregator** is an organisation that brings job-seekers or service providers onto the Blue Dots network. Before an aggregator can start working, it must apply, be reviewed by an admin, and have its accounts automatically set up across several systems. This entire journey — from the applicant filling a form to the organisation going live — is what the registration subsystem manages.

The design covers:

- How applications are submitted, deduplicated, and stored safely
- How admins review and decide on applications without needing a login
- How accounts are automatically created across the identity provider (Keycloak by default), Signals-DPG (network), and the portal database
- How the system recovers if any automated step fails partway through
- How abandoned applications are closed out, with personal data retained for audit/re-open and secured by encryption at rest (planned)

---

## 2. Background & Problem Statement

### Background

Blue Dots is a platform for the blue collar workforce, operating as a Digital Public Good (DPG). Aggregators — NGOs, staffing agencies, training institutes — join the network to onboard workers and employers. Each aggregator must be approved before it gains access.

Before the current design, the onboarding process was fragile: a form submission immediately triggered a series of calls to external systems (Keycloak, Signals-DPG). If any call failed mid-way, the registration was silently stuck with no automated recovery.

### Problem Statement

The registration flow must solve five real problems, explained in plain terms:

**Problem 1 — Partial failures leave applications stuck.**
If the system creates an identity account but then the network goes down before the next step, the applicant ends up in limbo — account half-created, no way to fix it automatically.

**Problem 2 — Submitting the same form twice creates duplicates.**
Without deduplication, an impatient applicant clicking Submit twice would create two identical applications and two user accounts.

**Problem 3 — Email addresses can be probed.**
If the system returns different responses for "email already registered" vs "new email", anyone can silently discover whether an email address is in the database — a privacy risk.

**Problem 4 — Concurrent actions corrupt data.**
Two admins acting on the same application at the same moment, or two automated workers retrying the same step, can race and produce inconsistent state.

**Problem 5 — Personal data must be protected at rest.**
Abandoned and completed applications retain the applicant's personal data (name, phone, email) so the records can be audited or re-opened. Rather than purging that data, the platform will protect PII through field-level encoding/encryption at rest (planned for a later stage). This keeps records intact for legitimate recovery while addressing the security concern.

---

## 3. Key Design Problems

The following ordered list identifies the core problems the design must solve:

| #   | Problem Area               | Core Challenge                                                                                                                            |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Durability**             | Every step of onboarding must be recoverable — a crash at any point should not require manual intervention                                |
| P2  | **Idempotency**            | Retrying any step (email send, account creation, org registration) must never cause duplicates                                            |
| P3  | **Privacy**                | The submit endpoint must not leak whether an email or phone is already registered                                                         |
| P4  | **Concurrency safety**     | Two workers or two admin clicks must never corrupt the application's state                                                                |
| P5  | **Dead-letter protection** | Steps that fail repeatedly should stop retrying automatically; they must not retry forever                                                |
| P6  | **PII protection**         | Personal data is retained (not purged) for audit/re-open; it will be secured via field-level encoding/encryption at rest in a later stage |
| P7  | **Admin UX**               | Admins should be able to approve or decline from their email inbox, without logging into a dashboard                                      |
| P8  | **Re-openability**         | Stuck or timed-out applications should be recoverable by an admin without re-submitting from scratch                                      |

---

## 4. Design

### 4.1 Core principle: write first, act second

Every action in the registration flow follows the same pattern:

1. **Write the state change to the database** in a single atomic operation.
2. **Then attempt the side effects** (send emails, create accounts, push to Signals-DPG).

This means the database is always consistent, even if every external call fails. A separate repair process (the reconciler) looks at the database, sees which steps are incomplete, and retries only those steps.

### 4.2 Application lifecycle — state machine

An application moves through a fixed set of states driven by a defined set of actions. States describe **where the application is**; actions describe **what an actor does** to move it forward.

#### Entry and exit

- **Entry:** An applicant submits (or re-submits) the registration form. This always creates or re-opens a `submitted` row.
- **Exit (success):** `active` — all accounts set up; the aggregator can log in.
- **Exit (failure):** `abandoned` — permanently closed; data retained (see §4.5). Reached when a TTL expires or when an application has been declined more than `REGISTRATION_MAX_DECLINE_COUNT` times.

#### Actions

| Action         | Actor      | What it does                                              |
| -------------- | ---------- | --------------------------------------------------------- |
| `submit`       | Applicant  | Submits the form for the first time                       |
| `re-submit`    | Applicant  | Re-submits an identical form after a decline              |
| `verify-email` | Applicant  | Clicks the verification link in the email                 |
| `approve`      | Admin      | Clicks Approve in the admin notification email            |
| `decline`      | Admin      | Clicks Decline in the admin notification email            |
| `expire`       | Reconciler | Abandons the application when a TTL threshold is exceeded |

#### States

| State          | Meaning                                                      |
| -------------- | ------------------------------------------------------------ |
| `submitted`    | Form received; verification email sent to applicant          |
| `verified`     | Email confirmed; awaiting admin decision                     |
| `provisioning` | Admin approved; accounts being set up across systems         |
| `active`       | All setup complete; aggregator can log in **[SUCCESS exit]** |
| `declined`     | Admin declined; applicant may re-submit                      |
| `abandoned`    | Permanently closed; data retained **[FAILURE exit]**         |

#### Transition diagram

```
  Entry: submit / re-submit action
              │
              ▼
       ┌────────────┐
       │ submitted  │◄──── re-submit (after decline)
       └────────────┘
          │        │
  verify-email    expire action
  action          (72 h unverified TTL, via reconciler)
          │        │
          ▼        │
       ┌────────┐  │
       │verified│──┤ expire action (168 h stuck TTL, via reconciler)
       └────────┘  │         │
       │        │  │         │
   approve    decline        │     ┌──────────────────────────────┐
   action     action         └────►│         abandoned             │
       │        │                  │  (terminal —                  │
       │        ▼                  │   data retained)              │
       │   ┌─────────┐             │     EXIT: FAILURE             │
       │   │ declined│─decline × N─►    (also via expire action)   │
       │   └─────────┘             └──────────────────────────────┘
       │        │                                ▲
       │   re-submit action                      │
       │   (back to submitted)                   │
       │                                         │
       ▼                        expire action    │
  ┌──────────────┐              (168 h stuck TTL)│
  │ provisioning │──────────────────────────────►┘
  └──────────────┘
       │
  graduation steps complete
       │
       ▼
  ┌────────┐
  │ active │   EXIT: SUCCESS
  └────────┘
```

**TTL rules:**

- `submitted` rows: abandoned after `REGISTRATION_UNVERIFIED_TTL_HOURS` (default 72 h)
- `verified` and `provisioning` rows: abandoned after `REGISTRATION_STUCK_TTL_HOURS` (default 168 h)
- Both TTLs are checked and applied by the reconciler on each run — they do not trigger automatically.

**Note on `declined`:** A declined application is **not** terminal. The applicant may re-submit the identical form, which re-opens the registration to `submitted`. After `REGISTRATION_MAX_DECLINE_COUNT` total declines (accumulated across all re-submits on the same row), the next decline transitions directly to `abandoned`.

**Note on decline_count accumulation:** `decline_count` is stored on the registration row and is never reset when an applicant re-submits. This is intentional — it prevents an applicant from cycling through decline → re-submit indefinitely. The total number of declines across all re-submission attempts counts toward the limit.

### 4.3 End-to-end functional flow

```
Applicant             Portal / API              Admin email            Reconciler
─────────             ────────────              ───────────            ──────────

1. Fill form
   └─► POST /v1/aggregator/registration/create
       ├─ Deduplicate (SHA-256 fingerprint)
       ├─ Insert registration row (submitted)
       └─ 202 Accepted ──────────────────────────────────────────────────────────►
           │
           └─ [inline] Send verification email ──────────────────────────────────►
                                                                      applicant inbox
                                                                           │
2. Click verify link ◄──────────────────────────────────────────────────────────┘
   └─► GET /v1/aggregator/registration/verify?id=...&token=...
       ├─ Validate JWT
       ├─ submitted → verified (CAS)
       └─ [inline] Send admin notification ────────────────────────────► admin inbox
                                                                           │
3. Admin clicks Approve or Decline ◄───────────────────────────────────────────┘
   └─► GET /admin/v1/aggregator/registration/read/:id?token=...&intent=approve
       └─ Show confirmation page with application details + note text area
           │   (note required for decline, optional for approve; max 500 chars)
           │
   └─► POST /admin/v1/aggregator/registration/decision/:id
       ├─ Validate JWT
       ├─ Validate note (required for decline)
       ├─ verified → provisioning / declined (CAS)
       ├─ Store admin note in registration row; emit OTel state-transition event
       └─ [inline] Run provisioning steps (best-effort, if approved):
           ├─ ensureGraduated       → create aggregators row (status=pending) + mint aggregator_id
           ├─ ensureIdpUser         → find-or-create IdP user; enable; set aggregator_id
           ├─ ensureSignalstackOrg  → register org in Signals-DPG
           ├─ ensureWelcomeSent     → email applicant with login link + any admin note
           └─ ensureActivated       → when all above done: provisioning → active; aggregators.status → active
              (or ensureIdpUserDisabled + ensureDeclineSent with admin note for decline)

4. If any inline step failed ──────────────────────────────────────────────────►
   Reconciler retries only the failed steps on next tick
```

### 4.4 Deduplication and idempotency

**Submit deduplication:** On every form submit, the API computes a deterministic fingerprint from `email + phone + orgName` (SHA-256). A second identical submission finds the existing row and returns a response based on the current state — no new record is created.

**Response by current state:**

| Existing row state | Response                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `submitted`        | `202 Accepted` — verification email already sent; applicant should check inbox            |
| `verified`         | `202 Accepted` — application is under admin review; no action needed                      |
| `provisioning`     | `202 Accepted` — accounts are being set up; applicant will receive a welcome email        |
| `active`           | `200 OK { "status": "already_active" }` — the organisation is already live on the network |
| `declined`         | Re-opens to `submitted`; sends a new verification email (same as applicant re-submit)     |
| `abandoned`        | Re-opens to `submitted`; sends a new verification email                                   |

**Silent 202 for probe prevention:** For all states except `active`, the response is `202 Accepted`. This prevents the form from being used to discover whether an email is in the system. The `active` state response breaks this pattern intentionally — the applicant clearly already knows their organisation is registered.

**Re-submit refreshes the payload:** When a `declined` or `abandoned` row is re-opened by re-submit, the `profile_draft`, the org fields, **and the `consent` block** are updated from the new submission — the most recent consent (with fresh `given_at`/`valid_till`) governs. The fingerprint fields (`email`, `phone`, `orgName`) are unchanged by definition; changing any of them produces a new row instead of re-opening this one.

**Provisioning step idempotency:** Every `ensure-*` step checks whether it has already completed (`provisionState[step] === 'done'`) before doing any work. Running a completed step is a safe no-op.

**Aggregator creation idempotency:** The `aggregators` table stores a `source_registration_id` column. If graduation is retried, the INSERT recognises the existing row and returns it instead of creating a duplicate.

**Verification link expiry:** If an applicant's verification link expires (60-minute JWT TTL), they receive a `TOKEN_EXPIRED` error on click. There is no self-service re-send endpoint — this is a deliberate design choice to avoid an abuse-prone public endpoint. The reconciler automatically re-sends the verification email on its next run, subject to the `REGISTRATION_VERIFICATION_RESEND_COOLDOWN_MINUTES` cooldown. Applicants who receive an expired link should wait and check their inbox again, or contact support.

### 4.5 Provisioning steps

After an admin approves an application, the system must set up accounts in three places. Each step is independent and tracked separately.

**For approval:**

```
ensureGraduated
  └─ Create aggregators row (source_registration_id = idempotency key)
  └─ aggregators.status = 'pending' (NOT active yet)
  └─ Mint aggregator_id and persist on the registration row (consumed by ensureIdpUser)
  └─ Does NOT transition state — the row stays in provisioning

ensureIdpUser
  └─ Find or create IdP user by email
  └─ Persist idp_user_id immediately (crash-safe)
  └─ Enable user; set decision_made = 'approved'; set aggregator_id

ensureSignalstackOrg
  └─ Upsert org in Signals-DPG; store returned ss_org_id

ensureWelcomeSent
  └─ Send welcome email with portal login link
  └─ Include admin note verbatim in email body if provided
  └─ Stamp welcome_sent_at atomically with provision mark

ensureActivated
  └─ Guard: idp_user, ss_org, welcome all 'done' (else no-op until they are)
  └─ provisioning → active transition (CAS)
  └─ Flip aggregators.status 'pending' → 'active' atomically with the transition
```

**Why `ensureActivated` is a separate, last step:** `ensureGraduated` must run first because it mints the `aggregator_id` that `ensureIdpUser` writes to the identity profile — but it deliberately does **not** flip the registration to `active`. If it did, the row would become terminal (reconciler skips `active` rows, §4.7) and any later failure in `ensureIdpUser`, `ensureSignalstackOrg`, or `ensureWelcomeSent` could never be retried. Instead, `ensureActivated` performs the `provisioning → active` transition only once all three of those steps are `done`, so a partial failure keeps the row in `provisioning` where the reconciler will repair it.

**For decline:**

```
ensureIdpUserDisabled
  └─ Find IdP user; set decision_made = 'declined'; disable account

ensureDeclineSent
  └─ Send decline email to applicant
  └─ Include admin note verbatim in email body so the applicant knows what to fix
```

**For abandoned applications:**

No data is purged. When an application is abandoned, its row is retained as-is — contact details and profile draft stay in place — so it can be audited or re-opened later. The only side effect is to disable the identity account if one was ever created:

```
ensureIdpUserDisabled   (only when idp_user_id is set — i.e. abandoned from provisioning)
  └─ Disable IdP user; set decision_made = 'abandoned'
  └─ IdP user is NOT deleted
  └─ The Signals-DPG org and the pending aggregators row are left untouched (retained)
```

For abandonment from `submitted` or `verified`, no IdP account exists yet, so this step is an immediate no-op.

> **PII protection (planned):** Rather than deleting personal data on abandonment, the platform will protect PII through **field-level encoding/encryption at rest** in a later stage. This addresses the data-security concern while keeping records intact for legitimate recovery and audit. Until then, the `registrations` table is protected by the existing infrastructure-level access controls.

### 4.6 Dead-letter protection

Each provisioning step tracks how many times it has been attempted. After `REGISTRATION_MAX_PROVISION_ATTEMPTS` failures (default: 5), the step is marked `dead`. **The first time a step on a given registration reaches `dead`, the reconciler performs a one-time auto-reopen:** it resets that step (`attempts → 0`, state → `pending`) and sets `auto_reopened = true`, giving the step one more full retry cycle. This recovers from transient outages that outlast the initial attempt budget. If the step dead-letters a **second** time (`auto_reopened` already set), it stays `dead` and the row proceeds toward TTL abandonment. An operator can still reset a dead step manually via the reopen endpoint.

This auto-reopen also covers `ensureActivated`'s gating steps: a transiently-failed `idp_user`, `ss_org`, or `welcome` gets a second cycle before the approved row risks TTL abandonment, so a single transient outage cannot silently drop an admin's approval.

```
provisionState[key]:  pending → failed → failed → ... → dead → (auto-reopen once) → pending → ... → dead (final)
provisionAttempts[key]: { attempts: N, last_attempt_at: "2026-06-19T...", auto_reopened: false }
```

### 4.7 Reconciler — repair without a scheduler

The reconciler is an on-demand repair process. There is no built-in background scheduler — it runs when triggered by an admin API call. This keeps infrastructure costs low (no always-on worker process needed).

Operators are responsible for calling the reconcile API on a regular cadence using whatever external scheduler they already operate (cron job, CI pipeline, APM alert, or manual trigger). The `REGISTRATION_UNVERIFIED_TTL_HOURS` and `REGISTRATION_STUCK_TTL_HOURS` thresholds are checked by the reconciler at each run — they do not trigger anything automatically.

**Recommended cadence:** Triggering once every few hours is sufficient for most deployments, given the default TTLs of 72 h (unverified) and 168 h (stuck). The reconciler claim TTL (10 minutes) sets the minimum safe interval between concurrent runs — two simultaneous calls cannot both claim the same row.

**Reconcilable states:** The reconciler processes all rows in `submitted`, `verified`, `provisioning`, and `declined` states that have incomplete or failed provision steps. `active` is skipped entirely. `abandoned` rows are skipped for state purposes, but the reconciler still completes an incomplete `idp_disabled` step on them — the identity account of an abandoned applicant must end up disabled even if the inline disable failed. `declined` rows are reconciled because their provision steps (`idp_disabled`, `decline_sent`) can fail — an applicant must always receive their decline notification.

When triggered, the reconciler:

1. Claims all reconcilable rows with incomplete provision steps (atomic claim with TTL)
2. Retries each incomplete step using the same `ensure-*` functions
3. Applies TTL rules: abandons `submitted` rows past `REGISTRATION_UNVERIFIED_TTL_HOURS`; abandons `verified` or `provisioning` rows past `REGISTRATION_STUCK_TTL_HOURS`
4. Releases claims when done

Claim locking prevents two concurrent reconciler runs from stepping on each other. A claim expires after 10 minutes — a crashed run cannot permanently block rows.

### 4.8 Admin token-based approval (no login required)

Admins receive an email with two clickable links: Approve and Decline. Each link carries its **own** signed JWT with an embedded `intent` claim (`approve` or `decline`) — the two links are not interchangeable, so a single token authorises exactly one action.

```
Admin email link structure:
  GET /admin/v1/aggregator/registration/read/:id?token=<JWT>&intent=approve
       │
       └─ Renders confirmation page (HTML)
           │   Shows application details + a text area for a note
           │   (note required for decline, optional for approve; max 500 chars)
           │
           └─ Admin fills in note (if declining) and clicks "Confirm"
               │
               POST /admin/v1/aggregator/registration/decision/:id
               { token, decision: "approve"|"decline", note: "<admin note>" }
```

The decision endpoint re-checks the current state before acting. Clicking an already-acted link shows an "already decided" page — no duplicate action possible.

**Intent enforcement:** The endpoint compares the JWT's embedded `intent` claim against the `decision` field in the request body. A mismatch (e.g. an `approve`-scoped token submitted with `decision: "decline"`) is rejected with `403 INTENT_MISMATCH` and changes nothing. The `intent` query param on the read URL is presentation-only — the JWT claim is authoritative, so tampering with the URL param cannot escalate to a different action.

**Admin note flow:** The note the admin enters is:

1. Emitted as an OpenTelemetry state-transition event carrying the full decision context (from/to state, actor, reason, note) — the observability backend is the source of truth for audit history.
2. Written into `registrations.latest_admin_note` for fast in-process access (most recent note only; no join needed).
3. Included verbatim in the decline email so the applicant understands exactly what to correct before re-submitting.
4. Included in the approval welcome email if the admin provided one (e.g. activation instructions or conditions).
5. Returned in `GET /admin/v1/aggregator/registration/:id` via `latest_admin_note` on the registration object; full note history is available in the observability backend.

**Security model:** The API gateway (Kong/Keycloak) enforces **service-level authentication** on all `/admin/**` routes — typically an API key that restricts access to known internal callers. The gateway does **not** require an end-user Keycloak session. The signed JWT embedded in the email link is the admin's per-action authorisation — clicking the link is sufficient; no separate login is needed. This keeps the approval flow as simple as possible for admins who may not have a portal account.

> **Future enhancement:** As the admin dashboard functionality is built out, the gateway policy for `/admin/**` routes will be upgraded to require user-level authentication (Keycloak session). The JWT-in-link mechanism will remain as the per-action check. This document will be updated when that change is introduced.

**Multi-admin safety:** `NETWORK_FACILITATOR_ADMIN_EMAILS` can list several addresses — all notified admins receive the same email. If two admins click Approve simultaneously, only the first request succeeds; the second hits the optimistic-lock version check and is served an "already decided" page. Listing multiple admin emails is safe.

### 4.9 Re-opening abandoned applications

Abandoned applications can be re-opened by an admin. The re-open handler reads `registrations.previous_state` — a column updated to the `fromState` on every FSM transition — to determine what state the application was in before abandonment. It then restores the registration to that state, resetting only the appropriate fields.

| `previous_state` value | Re-opens to    | What is reset                                                                                                          |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `submitted`            | `submitted`    | All timestamps and provision steps cleared; re-sends verification email                                                |
| `verified`             | `verified`     | Admin notification and approval fields cleared; re-notifies admin                                                      |
| `provisioning`         | `provisioning` | Only the reconciler claim cleared; existing provision steps preserved; reconciler picks up remaining steps on next run |

### 4.10 Identity provider flexibility

The system integrates with an identity provider (IdP) for user account management. **Keycloak is the default implementation**, but the design explicitly supports swapping it out without touching any business logic.

All identity operations — create user, enable/disable user, find by email, set user attributes — go through an abstract `IdpAdminAdapter` class. Keycloak is the concrete implementation today, but any IdP that supports the same capabilities (FusionAuth, Authentik, Auth0, or a custom internal service) can be plugged in by implementing the same adapter.

```
IdpAdminAdapter (abstract)        ← all business logic depends on this
      │
      ├── KeycloakAdminAdapter    ← default; used in production today
      ├── FusionAuthAdminAdapter  ← (future) swap without changing provisioning logic
      └── AuthenticAdapter        ← (future) another option
```

**Operations the adapter must support:**

| Operation       | Used when                                                                                |
| --------------- | ---------------------------------------------------------------------------------------- |
| `createUser`    | Applicant's account is provisioned on approval                                           |
| `findByEmail`   | Idempotency check — does this applicant already have an account?                         |
| `findById`      | Used by reconciler when `idp_user_id` is already stored                                  |
| `enableUser`    | Account enabled after admin approves                                                     |
| `disableUser`   | Account disabled after admin declines                                                    |
| `deleteUser`    | Reserved — account teardown; not invoked in MVP now that abandonment retains the account |
| `setAttributes` | Aggregator ID and decision result written to the user profile                            |

To replace Keycloak: implement `IdpAdminAdapter` for the target IdP, inject it via configuration, and deploy. No provisioning logic changes.

---

## 5. Data Model

### `registrations` table

The primary record for an application. Every state change is atomic and recorded here.

| Column                    | Type          | Description                                                                                                                                                                                                                |
| ------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | UUID          | Primary key                                                                                                                                                                                                                |
| `idempotency_key`         | text (unique) | SHA-256 of `email + phone + orgName` — prevents duplicate rows on re-submit                                                                                                                                                |
| `state`                   | enum          | FSM state: `submitted`, `verified`, `provisioning`, `active`, `declined`, `abandoned`                                                                                                                                      |
| `contact_email`           | text          | Applicant email (lowercased, normalised)                                                                                                                                                                                   |
| `contact_phone`           | text          | E.164 normalised phone number                                                                                                                                                                                              |
| `org_name`                | text          | Organisation name                                                                                                                                                                                                          |
| `org_type`                | text          | Participant type for the network (e.g. `seeker`, `provider`)                                                                                                                                                               |
| `org_url`                 | text          | Optional website                                                                                                                                                                                                           |
| `org_locations`           | jsonb         | Operational locations                                                                                                                                                                                                      |
| `profile_draft`           | jsonb         | Full form payload carried through to provisioning                                                                                                                                                                          |
| `consent`                 | jsonb         | Consent record with `given_at` and `valid_till`; refreshed from the latest submission on re-submit                                                                                                                         |
| `idp_user_id`             | text          | Identity provider user ID — written immediately on account creation                                                                                                                                                        |
| `signalstack_org_id`      | text          | Signals-DPG org ID — written after org upsert                                                                                                                                                                              |
| `aggregator_id`           | UUID          | FK to `aggregators` — written at graduation                                                                                                                                                                                |
| `verification_sent_at`    | timestamp     | When the last verification email was sent                                                                                                                                                                                  |
| `verified_at`             | timestamp     | When the applicant clicked the verification link                                                                                                                                                                           |
| `admin_notified_at`       | timestamp     | When the admin notification was last sent                                                                                                                                                                                  |
| `approval_link_issued_at` | timestamp     | When the approval JWT was last minted                                                                                                                                                                                      |
| `welcome_sent_at`         | timestamp     | When the welcome email was sent (used for cooldown guard)                                                                                                                                                                  |
| `decline_sent_at`         | timestamp     | When the decline email was sent (used for cooldown guard)                                                                                                                                                                  |
| `decline_count`           | integer       | Total number of times the application has been declined — never reset on re-submit                                                                                                                                         |
| `previous_state`          | enum          | The FSM state the registration was in before its most recent transition — updated on every `store.transition()` call; used by the re-open flow to restore pre-abandonment state without querying the observability backend |
| `latest_admin_note`       | text          | Most recent admin note (approve or decline); nullable; written on every admin decision for fast in-process access                                                                                                          |
| `provision_state`         | jsonb         | Per-step status flags (see below)                                                                                                                                                                                          |
| `provision_attempts`      | jsonb         | Per-step attempt counters and timestamps (for dead-letter tracking)                                                                                                                                                        |
| `version`                 | integer       | Optimistic-lock counter — incremented on every state transition                                                                                                                                                            |
| `reconciler_claimed_at`   | timestamp     | Set while the reconciler holds this row; prevents concurrent repair                                                                                                                                                        |
| `created_at`              | timestamp     | Row creation time                                                                                                                                                                                                          |
| `updated_at`              | timestamp     | Last modification time                                                                                                                                                                                                     |

**PII protection (planned):** Personal data is **not** purged on abandonment — `contact_email`, `contact_phone`, and `profile_draft` are retained for audit and re-open. The data-security concern will be addressed by field-level encoding/encryption at rest in a later stage; for MVP the columns remain in plaintext, protected by infrastructure-level access controls. This plaintext-at-rest posture is an **accepted interim risk** for MVP and is tracked as planned work.

### `provision_state` keys

Each key in this JSONB column tracks one side-effect step. Values: `done`, `failed`, `pending`, `dead`.

| Key            | Step                                                                       | Notes                                                                      |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `verification` | Verification email sent to applicant                                       | Inline on submit; reconciler retries                                       |
| `admin_notify` | Admin notification email sent                                              | Inline after verify; reconciler retries                                    |
| `graduated`    | `aggregators` row created (status `pending`); `aggregator_id` minted       | Idempotency via `source_registration_id`; does **not** transition state    |
| `idp_user`     | Identity provider user created, enabled, attributes set                    | `idp_user_id` persisted before mark-done                                   |
| `idp_disabled` | Identity provider user disabled for **declined or abandoned** applications | Independent from `idp_user`; on abandon, runs only if `idp_user_id` is set |
| `ss_org`       | Signals-DPG org upserted                                                   | Reconciler retries                                                         |
| `welcome`      | Welcome email sent; `welcome_sent_at` stamped                              | Cooldown guard prevents rapid resend                                       |
| `activated`    | `provisioning → active`; `aggregators.status → active`                     | Gated on `idp_user`, `ss_org`, `welcome` all `done`                        |
| `decline_sent` | Decline email sent; `decline_sent_at` stamped                              | Cooldown guard prevents rapid resend                                       |

**Key naming note:** The keys `idp_user` and `idp_disabled` use abstract IdP naming. Although Keycloak is today's implementation, these key names are stable and will not change when the IdP is replaced.

**Dead-letter:** A step reaching `dead` is auto-reopened once (reset to `pending`, `auto_reopened = true`) for one more retry cycle; a second `dead` is final. The per-step counters are in `provision_attempts[key] = { attempts: N, last_attempt_at: "ISO", auto_reopened: bool }`.

### Observability — state transition events

There is no `registration_transitions` database table. Every FSM state change is emitted as an **OpenTelemetry event** by `store.transition()`. The operator's observability backend (Grafana Tempo, Jaeger, Honeycomb, or equivalent) is the authoritative source for the full transition history.

Each event carries:

| OTel attribute            | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `event.name`              | `registration.state_transition`                     |
| `registration.id`         | UUID of the registration                            |
| `registration.from_state` | Previous FSM state                                  |
| `registration.to_state`   | New FSM state                                       |
| `registration.actor`      | `applicant`, `admin`, `reconciler`, or `system`     |
| `registration.reason`     | Machine-readable slug from the canonical list below |
| `registration.admin_note` | Admin note if provided; omitted otherwise           |
| `registration.org_name`   | Organisation name (for correlation; not PII)        |
| `registration.version`    | Optimistic-lock version after the transition        |

**Canonical `reason` slugs:** the state-transition `reason` is drawn from this fixed set — the single source of truth, so code and tests use these exact values:

| Slug                    | Transition                                                 |
| ----------------------- | ---------------------------------------------------------- |
| `submitted_new`         | (none) → `submitted` — first submission                    |
| `applicant_reopened`    | `declined`/`abandoned` → `submitted` — applicant re-submit |
| `admin_reopened`        | `abandoned` → prior state — admin reopen endpoint          |
| `email_verification`    | `submitted` → `verified`                                   |
| `approval`              | `verified` → `provisioning`                                |
| `admin_declined`        | `verified` → `declined`                                    |
| `decline_limit_reached` | `verified` → `abandoned` — Nth decline                     |
| `ttl_expired`           | any → `abandoned` — reconciler TTL                         |
| `provision_complete`    | `provisioning` → `active` — `ensureActivated`              |

Non-transition operational events (e.g. a step auto-reopen, §4.6) are emitted under their own `event.name` and are not part of this state-transition slug set.

**Why OTel instead of a transitions table:** Audit queries, dashboards, and alerting are served by the observability backend without adding a write-heavy append-only table to the primary Postgres instance. The only transition-derived field the application itself needs at runtime is `previous_state` (for the re-open flow), which is kept directly on the `registrations` row.

### `aggregators` table

The live aggregator identity record, created at graduation.

| Key column               | Description                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | UUID primary key                                                                                                                                                         |
| `org_slug`               | Unique URL-safe identifier derived from org name                                                                                                                         |
| `source_registration_id` | FK back to `registrations` — the idempotency key for graduation retries                                                                                                  |
| `name`                   | Organisation display name                                                                                                                                                |
| `contact`                | Beckn-shaped contact block                                                                                                                                               |
| `status`                 | Lifecycle status: `pending` (set at graduation while provisioning completes), `active` (set by `ensureActivated` once all approval steps succeed), `inactive`, `retired` |

**`status` lifecycle:** `ensureGraduated` creates the `aggregators` row with `status = 'pending'`. The row is flipped to `active` only by `ensureActivated`, atomically with the registration's `provisioning → active` transition, once `idp_user`, `ss_org`, and `welcome` are all `done`. This guarantees an aggregator is never advertised as live while its identity account or Signals-DPG org is still being set up.

---

## 6. API Spec

### Public endpoints

These are called by the web portal's service account (no aggregator session required).

#### `POST /v1/aggregator/registration/create`

Submit a new application.

```
Request body:
{
  "name": "My NGO",
  "type": "seeker",                  // optional — participant role
  "url": "https://myngo.org",        // optional
  "contact": {
    "email": "contact@myngo.org",
    "phone": "+919876543210"
  },
  "locations": [...],                // Beckn location array
  "consent": {
    "version": "1.0",
    "given_at": "2026-06-01T10:00:00Z",
    "valid_till": "2027-06-01T10:00:00Z"
  }
}

Responses:
  202 Accepted           — new submission, or duplicate while in submitted/verified/provisioning/declined/abandoned state
  200 { "status": "already_active" } — duplicate submission for an already-active organisation
```

Rate-limited per email:IP. Duplicate submissions are handled per the state table in Section 4.4.

---

#### `GET /v1/aggregator/registration/status/:registrationId`

Allows an applicant to check their registration state and view the reason for a decline. The `registrationId` was included in the submission acknowledgement email.

The UUID serves as a lightweight capability token — it is unguessable (~122 bits of entropy) and grants read-only access to that registration's public status only. No auth header is required. This endpoint is intentionally **not** application-rate-limited; it relies on the UUID's entropy plus infrastructure-level protections (WAF/CDN/gateway) rather than an in-app limiter.

```
Response:
{
  "state": "submitted" | "verified" | "provisioning" | "active" | "declined" | "abandoned",
  "admin_note": "string | null",   // populated after an approve or decline decision
  "can_resubmit": true | false,    // true when state = "declined" and decline_count < REGISTRATION_MAX_DECLINE_COUNT
  "decline_count": N               // how many times declined so far
}
```

The portal displays this response when an applicant visits their registration status page, giving them full visibility without contacting support.

---

#### `GET /v1/aggregator/registration/verify?id=:registrationId&token=:jwt`

Verify the applicant's email. Called when the applicant clicks the link in their verification email.

```
Response: 200 { "verified": true }   (idempotent — safe to call again)
          400 { "error": "TOKEN_EXPIRED" | "TOKEN_INVALID" }
```

If the token has expired, the applicant should wait for the reconciler to send a new verification email (within `REGISTRATION_VERIFICATION_RESEND_COOLDOWN_MINUTES`). There is no self-service re-send endpoint.

---

### Admin endpoints

All `/admin/**` routes require authentication enforced by the API gateway. The gateway enforces service-level authentication (API key). The signed JWT in the email link provides the per-action admin authorisation — no separate user login is required. Route path prefix `/admin/v1/aggregator/registration` is intentional — the `/admin/` prefix makes gateway policy enforcement straightforward (one prefix rule covers all admin routes).

#### `GET /admin/v1/aggregator/registration/read/:id?token=:jwt&intent=approve|decline`

Renders an HTML confirmation page for the admin. The token is from the admin notification email. Shows "already decided" if the application is past the decision point.

The confirmation page includes:

- A summary of the application details
- A text area for the admin to enter a note (required for decline, optional for approve)
- Character limit indicator (max 500 chars)

---

#### `POST /admin/v1/aggregator/registration/decision/:id`

Record an approve or decline decision and start provisioning.

```
Request body:
{
  "token": "<approval JWT from email>",
  "decision": "approve" | "decline",
  "note": "..."                      // required for decline, optional for approve; max 500 chars
}

Validation:
  - the JWT's embedded `intent` claim must match `decision`; returns 403 { "error": "INTENT_MISMATCH" } otherwise
  - `note` is required when decision = "decline" (trimmed); returns 400 { "error": "NOTE_REQUIRED" } if absent or whitespace-only
  - `note` max length 500 chars after trimming; returns 400 { "error": "NOTE_TOO_LONG" } if exceeded

Response: HTML result page (success, already-decided, or error)
```

The `note` is written into `registrations.latest_admin_note` and emitted as an OTel state-transition event. It is delivered verbatim to the applicant in the decline email (or welcome email for approve). The full note history is available in the observability backend.

---

#### `GET /admin/v1/aggregator/registration`

List applications with filters.

```
Query params:
  state   — filter by FSM state
  page    — page number (default 1)
  limit   — rows per page (default 20)
  sort    — created_at | updated_at
  order   — asc | desc

Response: { items: [...], total: N, page: N, limit: N }
```

---

#### `GET /admin/v1/aggregator/registration/:id`

Fetch a single application.

```
Response:
{
  "registration": {
    ...
    "latest_admin_note": "string | null",  // most recent admin note (approve or decline)
    "previous_state": "string | null"      // state before the most recent transition
  }
}
```

Full transition history (all state changes with actor, reason, and note) is available in the observability backend via the `registration.id` attribute on `registration.state_transition` events.

---

#### `POST /admin/v1/aggregator/registration/reconcile`

Trigger a full repair pass over all reconcilable applications (`submitted`, `verified`, `provisioning`, `declined`). Returns counts of what was fixed, abandoned, or still failing.

**TTL enforcement happens here:** This endpoint checks `REGISTRATION_UNVERIFIED_TTL_HOURS` and `REGISTRATION_STUCK_TTL_HOURS` and abandons rows that have exceeded their limits. Operators should call this endpoint on a regular cadence — every few hours is sufficient for most deployments.

```
Response: {
  examined: N,
  repaired: N,      // provision steps successfully retried this run
  welcomed: N,
  declined: N,
  abandoned: N,
  warnings: N       // dead steps or unexpected conditions logged but not retried
}
```

---

#### `POST /admin/v1/aggregator/registration/reconcile/by-contact`

Trigger repair for a single application identified by email or phone. Useful for manually unblocking a stuck application.

```
Request body:
  { "email": "contact@example.org" }   // one of email or phone; if both provided, email takes precedence
  OR
  { "phone": "+919876543210" }

Response: same shape as full reconcile + the registration row
```

---

#### `POST /admin/v1/aggregator/registration/reopen/:id`

Re-open an abandoned application to its pre-abandonment state. After reopening a `provisioning`-state application, the operator should trigger the reconciler to pick up any remaining provision steps.

```
Request body:
  { "reason": "Reopening by admin request" }   // optional

Response: {
  "reopened": true,
  "targetState": "submitted" | "verified" | "provisioning"
}

Error responses:
  404 — registration not found
  409 { "error": "NOT_ABANDONED" } — registration is not in the abandoned state
```

---

### Configuration

| Variable                                            | Default                 | Description                                                                                                |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `NETWORK_FACILITATOR_ADMIN_EMAILS`                  | `""`                    | Comma-separated email addresses of network facilitator admins who receive application review notifications |
| `PUBLIC_API_URL`                                    | `http://localhost:4000` | Base URL of the API — used to build email links                                                            |
| `PUBLIC_PORTAL_URL`                                 | `http://localhost:3000` | Portal base URL — used in welcome emails                                                                   |
| `REGISTRATION_UNVERIFIED_TTL_HOURS`                 | `72`                    | Hours before an unverified (`submitted`) application is abandoned by the reconciler                        |
| `REGISTRATION_STUCK_TTL_HOURS`                      | `168`                   | Hours before a stuck `verified` or `provisioning` application is abandoned by the reconciler               |
| `REGISTRATION_VERIFICATION_LINK_TTL_MINUTES`        | `60`                    | Validity window for the email verification link sent to the applicant                                      |
| `REGISTRATION_VERIFICATION_RESEND_COOLDOWN_MINUTES` | `60`                    | Minimum gap between repeated verification email sends to the same applicant                                |
| `REGISTRATION_ADMIN_APPROVAL_TOKEN_TTL_HOURS`       | `168`                   | Validity window for the approve/decline JWT embedded in the admin notification email                       |
| `REGISTRATION_MAX_DECLINE_COUNT`                    | `3`                     | Total declines (across all re-submits) before the next decline transitions the application to `abandoned`  |
| `REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES`      | `60`                    | Minimum gap between repeated welcome or decline email sends                                                |
| `REGISTRATION_MAX_PROVISION_ATTEMPTS`               | `5`                     | Failures before a provisioning step is dead-lettered and stops being retried                               |
| `REGISTRATION_PROVISION_BACKOFF_BASE_SECONDS`       | `60`                    | Base interval for retry backoff; doubles each attempt (e.g. 60 s, 120 s, 240 s, ...)                       |
| `PUBLIC_SUBMIT_RATE_WINDOW_SECONDS`                 | `60`                    | Rate-limit window duration for the submit endpoint                                                         |
| `PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW`                 | `20`                    | Max submissions per email:IP pair within one rate-limit window                                             |

**TTL note:** TTL thresholds do not trigger automatically. They are evaluated each time the reconciler runs. An application is only abandoned when the reconciler is invoked AND the row has exceeded its threshold. Operators must schedule regular reconcile calls externally.

**Config constraint:** Keep `REGISTRATION_ADMIN_APPROVAL_TOKEN_TTL_HOURS` ≤ `REGISTRATION_STUCK_TTL_HOURS`. If the admin token TTL is longer than the stuck TTL, admins may click a link for a row that has already been abandoned by the reconciler. The decision endpoint handles this gracefully (shows an "already decided" page), but the UX is confusing. The safest configuration is to keep them equal (both 168 h by default).

---

## 7. Summary

The aggregator registration subsystem manages the full lifecycle of an aggregator application — from form submission through account activation.

**Key design choices:**

- **Database as the source of truth:** Every action writes to the database first. Side effects (emails, account creation) happen after and are always recoverable.

- **Idempotent everything:** Re-running any step — whether from a retry, a concurrent call, or an operator action — produces the same result. No duplicates, no partial states.

- **Silent 202 on submit:** All submit outcomes return `202 Accepted` to prevent email probing, with one exception: if the organisation is already `active`, the response is `200 { "status": "already_active" }` to give the applicant a useful signal.

- **Optimistic locking:** Every state transition uses a version counter to detect and reject concurrent writes safely.

- **Per-step tracking:** Each provisioning side-effect is tracked independently. A failure in one step does not block others.

- **Dead-letter protection:** Steps that fail repeatedly (more than `REGISTRATION_MAX_PROVISION_ATTEMPTS` times) are automatically stopped. An operator can reset them explicitly.

- **PII protection:** Personal data is retained on abandonment (not purged); it will be secured via field-level encoding/encryption at rest in a later stage.

- **Admin UX without login:** Admins approve or decline from their email inbox. The gateway enforces service-level auth; the signed JWT in the link is the admin's per-action authorisation. No user login required.

- **Pluggable identity provider:** All identity operations go through an `IdpAdminAdapter` abstraction. Keycloak is the default; any compatible IdP can be substituted by implementing the adapter.

- **No scheduler:** The reconciler runs on demand via an admin API call. Operators schedule it externally. This keeps infrastructure cost low — no always-on background process is required. Triggering every few hours is sufficient.

- **Re-openability:** Abandoned applications can be re-opened by an admin to any prior state, with the reconciler picking up and completing remaining steps automatically on the next reconcile trigger.

- **Decline count accumulates:** Total declines across all re-submission attempts count toward `REGISTRATION_MAX_DECLINE_COUNT`. Re-submitting does not reset the counter — this prevents indefinite cycling.
