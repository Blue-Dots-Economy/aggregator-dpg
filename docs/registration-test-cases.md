# Aggregator Registration — Functional Test Cases

Test cases for Test-Driven Development of the aggregator registration subsystem. Each case maps directly to a behaviour in `docs/registration-design.md`.

**Notation:**

- `Given` — precondition (database state, config)
- `When` — the action under test
- `Then` — expected outcome(s)

Cases are grouped by feature area. IDs are stable references for linking from code comments and PR descriptions.

---

## TC-SUBMIT — Form Submission (`POST /v1/aggregator/registration/create`)

### New submission

**TC-SUBMIT-01** — Happy path: first-time submission creates a registration row

- Given: no prior registration exists for this email + phone + orgName
- When: `POST /v1/aggregator/registration/create` with valid payload
- Then: HTTP 202 Accepted; a `registrations` row exists with `state = submitted`; `provision_state.verification = done` (or `failed` if email sending fails, never absent); `version = 1`

**TC-SUBMIT-02** — Verification email is sent inline on new submission

- Given: no prior registration for this applicant
- When: `POST /v1/aggregator/registration/create`
- Then: one verification email sent to `contact_email`; `verification_sent_at` is set; `provision_state.verification = done`

**TC-SUBMIT-03** — Verification email failure does not fail the submission

- Given: email service is unavailable
- When: `POST /v1/aggregator/registration/create`
- Then: HTTP 202 Accepted (not 5xx); row saved with `state = submitted`; `provision_state.verification = failed`; reconciler can retry later

**TC-SUBMIT-04** — Idempotency key is SHA-256 of normalised email + phone + orgName

- Given: two payloads with identical email, phone, orgName but different casing or whitespace
- When: both submitted sequentially
- Then: only one `registrations` row; second call returns 202 without inserting a new row

**TC-SUBMIT-05** — Email is normalised to lowercase before fingerprinting

- Given: no prior registration
- When: submit with `"email": "CONTACT@MyNGO.ORG"` then again with `"contact@myngo.org"`
- Then: single row; idempotency key is identical for both

**TC-SUBMIT-06** — Phone is normalised to E.164 before fingerprinting

- Given: no prior registration
- When: submit with `"+91 98765 43210"` and then `"+919876543210"`
- Then: same idempotency key; single row

### Deduplication by current state

**TC-SUBMIT-07** — Re-submit on `submitted` row → 202, no new row, no new email

- Given: existing row with `state = submitted`
- When: identical form submitted again
- Then: HTTP 202; same row unchanged; no additional verification email sent

**TC-SUBMIT-08** — Re-submit on `verified` row → 202, no new row, no new email

- Given: existing row with `state = verified`
- When: identical form submitted
- Then: HTTP 202; row stays `verified`; no admin re-notification

**TC-SUBMIT-09** — Re-submit on `provisioning` row → 202, no new row

- Given: existing row with `state = provisioning`
- When: identical form submitted
- Then: HTTP 202; row stays `provisioning`; no side effects triggered

**TC-SUBMIT-10** — Re-submit on `active` row → 200 `{ "status": "already_active" }`

- Given: existing row with `state = active`
- When: identical form submitted
- Then: HTTP 200 `{ "status": "already_active" }`; no row mutation

**TC-SUBMIT-11** — Re-submit on `declined` row → re-opens to `submitted`, sends verification email

- Given: existing row with `state = declined`, `decline_count = 1`
- When: identical form submitted
- Then: row transitions to `submitted`; `previous_state = declined`; `decline_count` unchanged (still 1); new verification email sent; `provision_state` reset; HTTP 202

**TC-SUBMIT-12** — Re-submit on `abandoned` row → re-opens to `submitted`, sends verification email

- Given: existing row with `state = abandoned` (data retained — original contact details still present)
- When: identical form submitted with fresh payload
- Then: row transitions to `submitted`; payload fields updated to the new submission values; `provision_state` fully reset; new verification email sent; HTTP 202

**TC-SUBMIT-13** — Privacy: all duplicate states except `active` return identical 202

- Given: separate registrations in each of `submitted`, `verified`, `provisioning`, `declined`, `abandoned`
- When: identical form re-submitted for each
- Then: all return HTTP 202; no state-specific error message or status code that reveals state

### Input validation

**TC-SUBMIT-14** — Missing required field `contact.email` → 400

- When: submit without `contact.email`
- Then: HTTP 400; row not created

**TC-SUBMIT-15** — Missing required field `contact.phone` → 400

- When: submit without `contact.phone`
- Then: HTTP 400; row not created

**TC-SUBMIT-16** — Missing required field `name` → 400

- When: submit without `name`
- Then: HTTP 400; row not created

**TC-SUBMIT-17** — Missing `consent` → 400

- When: submit without consent block
- Then: HTTP 400; row not created

**TC-SUBMIT-18** — Malformed email format → 400

- When: `"email": "not-an-email"`
- Then: HTTP 400; row not created

**TC-SUBMIT-19** — Malformed phone (not E.164) → 400

- When: `"phone": "9876543210"` (missing country code `+91`)
- Then: HTTP 400; row not created

**TC-SUBMIT-20** — `consent.given_at` missing → 400

- When: consent object lacks `given_at`
- Then: HTTP 400

**TC-SUBMIT-21** — `consent.version` missing → 400

- When: consent object lacks `version`
- Then: HTTP 400

**TC-SUBMIT-22** — Rate limit exceeded → rate-limited response

- Given: `PUBLIC_SUBMIT_RATE_MAX_PER_WINDOW = 5` per 60 s; same email:IP has made 5 submissions in the window
- When: sixth submission
- Then: HTTP 429 (or configured rate-limit error); no row created

**TC-SUBMIT-23** — Rate limit is per email:IP pair, not global

- Given: IP A has reached the rate limit; IP B has not
- When: IP B submits the same email
- Then: HTTP 202 for IP B; limit applies independently

---

## TC-VERIFY — Email Verification (`GET /v1/aggregator/registration/verify`)

**TC-VERIFY-01** — Happy path: valid token transitions `submitted → verified`

- Given: row with `state = submitted`; valid JWT minted for this registration
- When: `GET /v1/aggregator/registration/verify?id=:id&token=:jwt`
- Then: HTTP 200 `{ "verified": true }`; row `state = verified`; `verified_at` set; `version` incremented; `previous_state = submitted`

**TC-VERIFY-02** — Admin notification sent inline after verification

- Given: verification succeeds
- When: verify endpoint called
- Then: admin notification email sent to all `NETWORK_FACILITATOR_ADMIN_EMAILS` addresses; `provision_state.admin_notify = done`; `admin_notified_at` set

**TC-VERIFY-03** — Admin notification failure does not fail the verify response

- Given: email service unavailable for admin notification
- When: verify endpoint called with valid token
- Then: HTTP 200 `{ "verified": true }`; `provision_state.admin_notify = failed`; reconciler will retry

**TC-VERIFY-04** — Idempotent: already-verified token → 200, no state change

- Given: row with `state = verified`; original JWT still valid
- When: verify endpoint called again with the same token
- Then: HTTP 200 `{ "verified": true }`; row unchanged; no duplicate admin notification

**TC-VERIFY-05** — Expired token → 400 `TOKEN_EXPIRED`

- Given: JWT past its `REGISTRATION_VERIFICATION_LINK_TTL_MINUTES` window
- When: verify endpoint called
- Then: HTTP 400 `{ "error": "TOKEN_EXPIRED" }`; row state unchanged; reconciler will resend when cooldown passes

**TC-VERIFY-06** — Invalid token (bad signature) → 400 `TOKEN_INVALID`

- When: verify endpoint called with a tampered or random JWT
- Then: HTTP 400 `{ "error": "TOKEN_INVALID" }` ; row not affected

**TC-VERIFY-07** — Token for wrong registration ID → 400 `TOKEN_INVALID`

- Given: valid JWT issued for registration A
- When: called with `id` of registration B
- Then: HTTP 400 `{ "error": "TOKEN_INVALID" }`

**TC-VERIFY-08** — Verification of row not in `submitted` state (e.g. already `verified`) is safe

- Given: row `state = verified`
- When: verify called (idempotent case)
- Then: 200; no CAS failure; no error exposed to caller

**TC-VERIFY-09** — CAS version mismatch on verify → error, row not corrupted

- Given: row version has changed between token issuance and verify call (concurrent race)
- When: verify called with stale version
- Then: STALE_TRANSITION error handled internally; caller receives appropriate error; row remains in original state

---

## TC-STATUS — Applicant Status Endpoint (`GET /v1/aggregator/registration/status/:registrationId`)

**TC-STATUS-01** — Returns current state for a `submitted` registration

- Given: row with `state = submitted`, no admin note yet
- When: `GET /v1/aggregator/registration/status/:id`
- Then: HTTP 200 `{ state: "submitted", admin_note: null, can_resubmit: false, decline_count: 0 }`

**TC-STATUS-02** — Returns `can_resubmit: true` for `declined` within limit

- Given: row `state = declined`, `decline_count = 1`, `REGISTRATION_MAX_DECLINE_COUNT = 3`
- When: status called
- Then: `{ state: "declined", admin_note: "<note>", can_resubmit: true, decline_count: 1 }`

**TC-STATUS-03** — Returns `can_resubmit: false` for `declined` at or above limit

- Given: row `state = declined`, `decline_count = 3`, `REGISTRATION_MAX_DECLINE_COUNT = 3`
- When: status called
- Then: `{ state: "declined", can_resubmit: false, decline_count: 3 }`

**TC-STATUS-04** — Returns `can_resubmit: false` for `abandoned`

- Given: row `state = abandoned`
- When: status called
- Then: `{ state: "abandoned", can_resubmit: false }`

**TC-STATUS-05** — Returns `admin_note` populated after an approval decision

- Given: row approved with note `"Welcome! Your account is live."`
- When: status called
- Then: `{ state: "active", admin_note: "Welcome! Your account is live.", can_resubmit: false }`

**TC-STATUS-06** — Returns `admin_note` populated after a decline decision

- Given: row declined with note `"Your website URL was not accessible."`
- When: status called
- Then: `{ state: "declined", admin_note: "Your website URL was not accessible.", can_resubmit: true }`

**TC-STATUS-07** — Unknown registration ID → 404

- When: status called with a random UUID not in the database
- Then: HTTP 404

**TC-STATUS-08** — No auth required (UUID as capability token)

- When: status called without any Authorization header
- Then: HTTP 200 (not 401)

---

## TC-ADMIN-READ — Admin Confirmation Page (`GET /admin/.../read/:id`)

**TC-ADMIN-READ-01** — Valid token + intent=approve renders approve confirmation page

- Given: row `state = verified`; valid admin JWT with `intent = approve`
- When: `GET /admin/v1/aggregator/registration/read/:id?token=...&intent=approve`
- Then: HTTP 200 HTML; page contains application summary; note text area present; submit form targets `decision` endpoint

**TC-ADMIN-READ-02** — Valid token + intent=decline renders decline confirmation page

- Given: row `state = verified`; valid admin JWT with `intent = decline`
- When: GET with `intent=decline`
- Then: HTTP 200 HTML; note text area rendered; note marked as required; character limit visible (500)

**TC-ADMIN-READ-03** — Expired token → appropriate error page

- Given: JWT past `REGISTRATION_ADMIN_APPROVAL_TOKEN_TTL_HOURS`
- When: admin reads page
- Then: HTML error page indicating link expired; no approval form rendered

**TC-ADMIN-READ-04** — Invalid token (bad signature) → error page

- When: `token` is tampered
- Then: HTML error page; no application data shown

**TC-ADMIN-READ-05** — Already-decided registration shows "already decided" page

- Given: row `state = provisioning` or `active` (already approved)
- When: admin clicks link from original notification email
- Then: HTML page indicating decision already recorded; no form to re-decide

**TC-ADMIN-READ-06** — Abandoned registration shows "already decided" page

- Given: row `state = abandoned`
- When: admin clicks link
- Then: HTML "already decided" page

---

## TC-DECISION — Admin Decision Endpoint (`POST /admin/.../decision/:id`)

### Approve path

**TC-DECISION-01** — Approve happy path: transitions `verified → provisioning`

- Given: row `state = verified`, valid admin JWT
- When: `POST .../decision/:id` with `{ decision: "approve", token: "..." }`
- Then: row transitions to `provisioning`; `previous_state = verified`; `version` incremented; OTel `registration.state_transition` event emitted with `actor = admin`, `reason = approval`

**TC-DECISION-02** — Approve with optional note: note stored in `latest_admin_note`

- When: approve with `note: "All checks passed. Welcome aboard!"`
- Then: `registrations.latest_admin_note = "All checks passed. Welcome aboard!"`; OTel event includes `registration.admin_note` attribute

**TC-DECISION-03** — Approve without note: `latest_admin_note` remains null

- When: approve with no `note` field
- Then: `latest_admin_note = null`; OTel event has no `admin_note` attribute

**TC-DECISION-04** — Approve triggers inline provisioning steps

- When: approve is recorded
- Then: `ensureGraduated`, `ensureIdpUser`, `ensureSignalstackOrg`, `ensureWelcomeSent` are all attempted inline

**TC-DECISION-05** — Approve note included in welcome email

- When: approve with `note: "Please review the onboarding checklist in the portal."`
- Then: welcome email body contains the note verbatim

**TC-DECISION-06** — Approve with no note: welcome email still sent (no note section)

- When: approve with no `note`
- Then: welcome email sent without note section; no placeholder text shown

### Decline path

**TC-DECISION-07** — Decline happy path: transitions `verified → declined`

- Given: row `state = verified`, valid admin JWT, decline_count < MAX
- When: `POST .../decision/:id` with `{ decision: "decline", token: "...", note: "Registration incomplete." }`
- Then: row transitions to `declined`; `decline_count` incremented by 1; `previous_state = verified`; OTel event emitted with `reason = admin_declined`

**TC-DECISION-08** — Decline note is required: missing note → 400 `NOTE_REQUIRED`

- When: decline with no `note` field
- Then: HTTP 400 `{ "error": "NOTE_REQUIRED" }`; row state unchanged; no OTel event for this attempt

**TC-DECISION-09** — Decline note too long: > 500 chars → 400 `NOTE_TOO_LONG`

- When: decline with `note` of 501 characters
- Then: HTTP 400 `{ "error": "NOTE_TOO_LONG" }`; row state unchanged

**TC-DECISION-10** — Decline note exactly 500 chars → accepted

- When: decline with `note` of exactly 500 characters
- Then: HTTP 200 (success page); note stored

**TC-DECISION-11** — Decline note stored in `latest_admin_note`

- When: decline with `note: "Your website URL was unreachable."`
- Then: `registrations.latest_admin_note = "Your website URL was unreachable."`

**TC-DECISION-12** — Decline note included verbatim in decline email

- When: decline with `note: "Missing: physical address of operations."`
- Then: `ensureDeclineSent` sends email containing `"Missing: physical address of operations."`

**TC-DECISION-13** — Decline triggers inline provisioning: `ensureIdpUserDisabled` + `ensureDeclineSent`

- When: decline recorded
- Then: both steps attempted inline; `provision_state.idp_disabled` and `provision_state.decline_sent` reflect the result

**TC-DECISION-14** — Decline at `REGISTRATION_MAX_DECLINE_COUNT` limit → `declined → abandoned`

- Given: `decline_count = REGISTRATION_MAX_DECLINE_COUNT - 1`; row `state = verified`
- When: admin declines
- Then: row transitions to `abandoned` (not `declined`); data retained (no purge); `decline_count` still incremented

### Validation and race safety

**TC-DECISION-15** — Expired admin JWT → error page; no state change

- Given: JWT past `REGISTRATION_ADMIN_APPROVAL_TOKEN_TTL_HOURS`
- When: decision endpoint called
- Then: HTML error page; row state unchanged

**TC-DECISION-16** — Invalid JWT (tampered) → error page

- When: `token` field has bad signature
- Then: HTML error page; row unchanged

**TC-DECISION-17** — Already-decided: concurrent approve by two admins, first wins

- Given: two admin JWTs for the same row; row `state = verified`
- When: both `POST .../decision` called simultaneously with `decision: "approve"`
- Then: first request succeeds and transitions row; second request receives "already decided" HTML page; row version matches first request only; no double provisioning

**TC-DECISION-18** — Already-decided: decision on `provisioning` or `active` row

- Given: row already in `provisioning`
- When: admin decision endpoint called again
- Then: HTML "already decided" page; no state mutation

**TC-DECISION-19** — Decision on non-existent registration → 404

- When: `POST .../decision` with a random UUID
- Then: HTTP 404

**TC-DECISION-20** — OTel event attributes are complete on approve

- When: approve decision recorded
- Then: OTel event contains: `event.name = registration.state_transition`, `registration.from_state = verified`, `registration.to_state = provisioning`, `registration.actor = admin`, `registration.reason = approval`, `registration.org_name`, `registration.id`, `registration.version`

**TC-DECISION-21** — OTel event attributes are complete on decline

- When: decline decision recorded
- Then: OTel event contains above fields with `to_state = declined`, `reason = admin_declined`, plus `registration.admin_note = <note>`

---

## TC-PROV-APPROVE — Provisioning Steps (Approval)

### `ensureGraduated`

**TC-PROV-01** — Creates `aggregators` row with `status = pending`; does NOT transition state

- Given: row in `provisioning`; no existing `aggregators` row
- When: `ensureGraduated` runs
- Then: `aggregators` row created with `status = pending`, `source_registration_id = idempotency_key`; `aggregator_id` minted and persisted on the registration; row stays in `provisioning` (NOT `active`); `provision_state.graduated = done`

**TC-PROV-02** — Idempotent on retry: existing `aggregators` row not duplicated

- Given: `aggregators` row already exists with same `source_registration_id`
- When: `ensureGraduated` runs again
- Then: no duplicate row; `provision_state.graduated = done`; no error

**TC-PROV-03** — `aggregators.status` flips `pending → active` only via `ensureActivated`

- Given: `ensureGraduated` has created the row (`status = pending`); `idp_user`, `ss_org`, `welcome` all `done`
- When: `ensureActivated` runs
- Then: `aggregators.status = 'active'` and registration `state = active` are written atomically; if any of the three gating steps is not `done`, `ensureActivated` is a no-op and `status` stays `pending`

### `ensureIdpUser`

**TC-PROV-04** — Creates new IdP user when none exists

- Given: no IdP user for the applicant's email
- When: `ensureIdpUser` runs
- Then: IdP user created; `idp_user_id` persisted on registration row before `provision_state.idp_user = done`

**TC-PROV-05** — Finds existing IdP user by email (idempotent)

- Given: IdP user already exists for this email (prior partial run)
- When: `ensureIdpUser` runs
- Then: existing user found via `findByEmail`; `idp_user_id` updated; no duplicate user created; `provision_state.idp_user = done`

**TC-PROV-06** — `idp_user_id` persisted immediately (crash-safe)

- Given: IdP user successfully created
- When: provisioning crashes after user creation but before provision mark
- Then: on retry, `findById` resolves the existing user; no second user created; step completes

**TC-PROV-07** — User enabled and attributes set on approval

- When: `ensureIdpUser` runs for approval
- Then: IdP `enableUser` called; `setAttributes` called with `decision_made = approved` and `aggregator_id`

### `ensureSignalstackOrg`

**TC-PROV-08** — Upserts org in Signals-DPG; stores `ss_org_id`

- When: `ensureSignalstackOrg` runs
- Then: upsert call made to Signals-DPG; returned `ss_org_id` stored on registration row; `provision_state.ss_org = done`

**TC-PROV-09** — Idempotent on retry: upsert does not create duplicate org

- Given: `ss_org_id` already stored from prior partial run
- When: `ensureSignalstackOrg` runs again
- Then: upsert called (idempotent); same `ss_org_id` returned; `provision_state.ss_org = done`

### `ensureWelcomeSent`

**TC-PROV-10** — Sends welcome email with portal login link

- When: `ensureWelcomeSent` runs
- Then: email sent to `contact_email`; contains portal login link; `welcome_sent_at` stamped; `provision_state.welcome = done`

**TC-PROV-11** — Welcome email includes admin note verbatim when provided

- Given: `latest_admin_note = "Please log in within 7 days."`
- When: `ensureWelcomeSent` runs
- Then: email body contains `"Please log in within 7 days."`

**TC-PROV-12** — Welcome email sent without note section when no note provided

- Given: `latest_admin_note = null`
- When: `ensureWelcomeSent` runs
- Then: email sent; no placeholder for missing note; no error

**TC-PROV-13** — Cooldown guard: welcome email not resent if within cooldown window

- Given: `welcome_sent_at` set 30 minutes ago; `REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES = 60`
- When: `ensureWelcomeSent` runs again (reconciler retry)
- Then: email NOT sent; step skipped; `provision_state.welcome` remains `done`

**TC-PROV-14** — Cooldown guard: welcome email resent after cooldown passes

- Given: `welcome_sent_at` set 61 minutes ago
- When: `ensureWelcomeSent` runs
- Then: new welcome email sent; `welcome_sent_at` updated

---

## TC-PROV-DECLINE — Provisioning Steps (Decline)

### `ensureIdpUserDisabled`

**TC-PROV-15** — Disables IdP user on decline

- Given: `idp_user_id` stored on registration row
- When: `ensureIdpUserDisabled` runs
- Then: IdP `disableUser` called; `setAttributes` called with `decision_made = declined`; `provision_state.idp_disabled = done`

**TC-PROV-16** — Skips gracefully when no `idp_user_id` recorded

- Given: `idp_user_id` is null (never created — applicant was declined before IdP provisioning)
- When: `ensureIdpUserDisabled` runs
- Then: no error; step marked done or skipped appropriately

### `ensureDeclineSent`

**TC-PROV-17** — Sends decline email with admin note verbatim

- Given: `latest_admin_note = "Please provide a working organisation website URL."`
- When: `ensureDeclineSent` runs
- Then: email sent to `contact_email`; body contains the note verbatim; `decline_sent_at` stamped; `provision_state.decline_sent = done`

**TC-PROV-18** — Cooldown guard: decline email not resent within cooldown

- Given: `decline_sent_at` set 30 min ago; `REGISTRATION_WELCOME_RESEND_COOLDOWN_MINUTES = 60`
- When: `ensureDeclineSent` runs again
- Then: email NOT sent; step skipped

**TC-PROV-19** — Cooldown guard: decline email resent after cooldown

- Given: `decline_sent_at` set 61 min ago
- When: `ensureDeclineSent` runs
- Then: new decline email sent; `decline_sent_at` updated

---

## TC-PROV-RETAIN — Data Retention on Abandonment (purge removed)

PII purge was removed by design decision (§4.5). Abandoned rows retain all data; PII-at-rest security is deferred to a later field-level encoding/encryption stage. These cases assert that nothing is destroyed on abandonment.

**TC-PROV-RETAIN-01** — Abandonment does NOT redact `contact_email` / `contact_phone` / `profile_draft`

- Given: a row transitions to `abandoned` (via TTL or decline limit)
- When: the row is inspected afterwards
- Then: `contact_email`, `contact_phone`, and `profile_draft` retain their original submitted values; no sentinel substitution occurs

**TC-PROV-RETAIN-02** — Abandonment DISABLES the IdP user (does not delete it)

- Given: a `provisioning` row with an IdP user (`idp_user_id` set) is abandoned
- When: `ensureIdpUserDisabled` runs as part of abandonment
- Then: the IdP user is disabled (`decision_made = 'abandoned'`); `deleteUser` is NOT called; `provision_state.idp_disabled = done`; the Signals-DPG org and the `pending` aggregators row are left untouched

**TC-PROV-RETAIN-03** — No `purged` provision step exists

- When: an abandoned row's `provision_state` is inspected
- Then: there is no `purged` key; the reconciler schedules no purge/cleanup work for abandoned rows (abandonment is a pure state transition)

**TC-PROV-RETAIN-04** — Abandoned row re-opens with its original data intact

- Given: an `abandoned` row whose data was retained
- When: admin re-opens (or applicant re-submits)
- Then: the original contact details are available; a verification email can be sent to the real address (no sentinel problem)

**TC-PROV-RETAIN-05** — Abandonment from `submitted`/`verified` is a no-op for the IdP

- Given: a `submitted` or `verified` row (no `idp_user_id`) is abandoned
- When: abandonment runs
- Then: `ensureIdpUserDisabled` is an immediate no-op (no IdP call); no Signals-DPG org or aggregators row exists to touch

---

## TC-DEADLETTER — Dead-Letter Protection

**TC-DL-01** — Provision step marked `failed` after each failed attempt

- Given: `provision_state.idp_user = pending`; IdP service unavailable
- When: `ensureIdpUser` is attempted
- Then: `provision_state.idp_user = failed`; `provision_attempts.idp_user.attempts = 1`

**TC-DL-02** — Step transitions to `dead` after `REGISTRATION_MAX_PROVISION_ATTEMPTS` failures

- Given: `provision_attempts.idp_user.attempts = 4`; `REGISTRATION_MAX_PROVISION_ATTEMPTS = 5`
- When: fifth failure occurs
- Then: `provision_state.idp_user = dead`; `provision_attempts.idp_user.attempts = 5`

**TC-DL-03** — First `dead` triggers a one-time auto-reopen

- Given: `provision_state.idp_user = dead`; `provision_attempts.idp_user.auto_reopened = false`
- When: reconciler runs
- Then: the step is reset (`attempts → 0`, state → `pending`) and `auto_reopened = true`; `ensureIdpUser` is retried on this/the next cycle

**TC-DL-04** — Non-dead failed steps are still retried by reconciler

- Given: `provision_state.ss_org = failed` (attempts = 2)
- When: reconciler runs and ss_org is available
- Then: `ensureSignalstackOrg` called; on success `provision_state.ss_org = done`

**TC-DL-05** — Exponential backoff: step not retried before backoff window expires

- Given: `provision_attempts.idp_user.last_attempt_at` is 30 s ago; `REGISTRATION_PROVISION_BACKOFF_BASE_SECONDS = 60`; `attempts = 1` (backoff = 60 s)
- When: reconciler runs
- Then: step skipped (still within backoff window)

**TC-DL-06** — Step retried after backoff window passes

- Given: `last_attempt_at` is 65 s ago; backoff = 60 s
- When: reconciler runs
- Then: step retried

**TC-DL-07** — Dead step reset by re-open

- Given: `provision_state.idp_user = dead`; admin re-opens the application
- When: re-open endpoint called
- Then: `provision_state` cleared (for submitted re-open) or step reset (for provisioning re-open); step retried on next reconciler run

**TC-DL-08** — Second `dead` is final (no further auto-reopen)

- Given: `provision_state.idp_user = dead`; `provision_attempts.idp_user.auto_reopened = true` (already auto-reopened once)
- When: reconciler runs
- Then: the step stays `dead` and is not retried; the row proceeds toward TTL abandonment; only a manual reopen can reset it

**TC-DL-09** — Auto-reopen of a gating step lets `ensureActivated` complete

- Given: an approved row in `provisioning`; `idp_user` dead-lettered once on a transient outage, now recovered; `ss_org` and `welcome` are `done`
- When: the auto-reopen retries `idp_user` and it succeeds
- Then: `ensureActivated`'s guard is satisfied; row transitions `provisioning → active`; the approval is not lost to TTL abandonment

---

## TC-RECONCILE — Reconciler Full Pass (`POST /admin/.../reconcile`)

### Retry behaviour

**TC-REC-01** — Retries failed `verification` step for `submitted` rows

- Given: row `state = submitted`; `provision_state.verification = failed`
- When: reconciler runs; email service is now available
- Then: verification email resent; `provision_state.verification = done`; `verification_sent_at` updated

**TC-REC-02** — Retries failed `admin_notify` step for `verified` rows

- Given: row `state = verified`; `provision_state.admin_notify = failed`
- When: reconciler runs
- Then: admin notification email sent; `provision_state.admin_notify = done`

**TC-REC-03** — Retries failed approval provision steps for `provisioning` rows

- Given: row `state = provisioning`; `provision_state.ss_org = failed`; other steps done
- When: reconciler runs
- Then: `ensureSignalstackOrg` called; on success `provision_state.ss_org = done`

**TC-REC-04** — Retries failed `idp_disabled` and `decline_sent` for `declined` rows

- Given: row `state = declined`; `provision_state.decline_sent = failed`
- When: reconciler runs
- Then: `ensureDeclineSent` called; decline email sent with stored `latest_admin_note`

**TC-REC-05** — Skips `active` rows (terminal state)

- Given: rows in `active` state
- When: reconciler runs
- Then: no action taken on active rows

**TC-REC-06** — Skips `abandoned` rows except completing an incomplete `idp_disabled` step

- Given: an `abandoned` row with `idp_user_id` set and `provision_state.idp_disabled = failed`
- When: reconciler runs
- Then: no state change; `ensureIdpUserDisabled` is retried until `done` (the lone exception to skipping abandoned rows); abandoned rows with no incomplete `idp_disabled` step get no action

### TTL enforcement

**TC-REC-07** — Abandons `submitted` rows past `REGISTRATION_UNVERIFIED_TTL_HOURS`

- Given: row `state = submitted`; `created_at` is 73 hours ago; `REGISTRATION_UNVERIFIED_TTL_HOURS = 72`
- When: reconciler runs
- Then: row transitions to `abandoned`; data retained (no purge); OTel event emitted with `reason = ttl_expired`

**TC-REC-08** — Does NOT abandon `submitted` rows within TTL window

- Given: row `state = submitted`; `created_at` is 48 hours ago
- When: reconciler runs
- Then: row remains `submitted`; verification retried if failed

**TC-REC-09** — Abandons `verified` rows past `REGISTRATION_STUCK_TTL_HOURS`

- Given: row `state = verified`; `verified_at` is 169 hours ago; `REGISTRATION_STUCK_TTL_HOURS = 168`
- When: reconciler runs
- Then: row transitions to `abandoned`; OTel event with `reason = ttl_expired`

**TC-REC-10** — Abandons `provisioning` rows past `REGISTRATION_STUCK_TTL_HOURS`

- Given: row `state = provisioning`; age > `REGISTRATION_STUCK_TTL_HOURS`
- When: reconciler runs
- Then: row transitions to `abandoned`

**TC-REC-11** — `declined` rows are NOT abandoned by TTL (applicant may re-submit)

- Given: row `state = declined`; `updated_at` is 200 hours ago
- When: reconciler runs
- Then: row stays `declined`; no TTL abandonment; decline provision steps retried if needed

### Concurrency safety

**TC-REC-12** — Claim locking prevents two reconciler runs from processing the same row

- Given: two reconciler runs triggered simultaneously; same reconcilable row present
- When: both runs attempt to claim the row
- Then: only one run holds the claim; other run skips the row; no duplicate side effects

**TC-REC-13** — Expired claim (>10 min) is available for re-claim

- Given: `reconciler_claimed_at` is 11 minutes ago (claiming run crashed)
- When: new reconciler run starts
- Then: row is claimed by the new run; processing continues

**TC-REC-14** — Verification resend respects cooldown

- Given: `verification_sent_at` is 30 min ago; `REGISTRATION_VERIFICATION_RESEND_COOLDOWN_MINUTES = 60`
- When: reconciler runs for a `submitted` row with `verification = done`
- Then: no resend; step skipped

**TC-REC-15** — Verification resent after cooldown

- Given: `verification_sent_at` is 61 min ago; token has expired
- When: reconciler runs
- Then: new verification email sent; `verification_sent_at` updated

### Response counts

**TC-REC-16** — Reconciler response counts are accurate

- Given: 3 rows repaired, 1 abandoned, 2 with dead steps (warnings)
- When: reconciler runs
- Then: response `{ examined: 6, repaired: 3, abandoned: 1, warnings: 2, ... }`

**TC-REC-17** — Reconciler skips rows with no incomplete steps

- Given: row `state = submitted`; all steps done; within TTL
- Then: row examined but not counted as repaired; no side effects triggered

---

## TC-REC-CONTACT — Reconciler by Contact (`POST /admin/.../reconcile/by-contact`)

**TC-REC-CONTACT-01** — Finds and repairs by email

- Given: stuck row identified by `contact_email`
- When: `{ "email": "contact@myngo.org" }` submitted
- Then: that registration row repaired; response includes registration object

**TC-REC-CONTACT-02** — Finds and repairs by phone

- When: `{ "phone": "+919876543210" }` submitted
- Then: matching row repaired

**TC-REC-CONTACT-03** — Both email and phone provided: email takes precedence

- Given: two rows, one matching email, one matching phone (different applicants)
- When: both email and phone submitted
- Then: email-matching row targeted; phone match ignored

**TC-REC-CONTACT-04** — Unknown contact → 404

- When: email or phone not found in database
- Then: HTTP 404

**TC-REC-CONTACT-05** — Row already in terminal state → no-op, response includes row

- Given: row `state = active`
- When: reconcile by contact called
- Then: no mutation; response includes the active row; no error

---

## TC-DECLINE-LIMIT — Decline Count and Limit

**TC-DL-COUNT-01** — `decline_count` incremented on each admin decline

- Given: `decline_count = 0`
- When: admin declines
- Then: `decline_count = 1`

**TC-DL-COUNT-02** — `decline_count` never reset on applicant re-submit

- Given: `decline_count = 2`; applicant re-submits (row re-opens to `submitted`)
- When: row inspected after re-submit
- Then: `decline_count = 2` (not 0)

**TC-DL-COUNT-03** — Third decline at limit (MAX=3) → `abandoned` not `declined`

- Given: `decline_count = 2`; `REGISTRATION_MAX_DECLINE_COUNT = 3`; row `state = verified`
- When: admin declines
- Then: row transitions to `abandoned`; `decline_count = 3`; OTel event with `reason = decline_limit_reached`; data retained (no purge)

**TC-DL-COUNT-04** — Second decline within limit → `declined`, applicant can re-submit

- Given: `decline_count = 1`; `REGISTRATION_MAX_DECLINE_COUNT = 3`
- When: admin declines
- Then: row `state = declined`; `decline_count = 2`; `can_resubmit = true` on status endpoint

**TC-DL-COUNT-05** — Re-submit after second decline preserves count and starts fresh flow

- Given: `decline_count = 2`; row re-opened to `submitted`
- When: applicant verifies email again; admin views application
- Then: admin can see current `decline_count = 2` on the registration; flow continues from `verified`

---

## TC-REOPEN — Re-opening Abandoned Applications (`POST /admin/.../reopen/:id`)

**TC-REOPEN-01** — Re-opens `abandoned` (previous=submitted) to `submitted`; sends verification email

- Given: row `state = abandoned`; `previous_state = submitted`
- When: `POST .../reopen/:id`
- Then: HTTP 200 `{ reopened: true, targetState: "submitted" }`; row `state = submitted`; all timestamps reset; `provision_state` cleared; new verification email sent

**TC-REOPEN-02** — Re-opens `abandoned` (previous=verified) to `verified`; re-notifies admin

- Given: row `state = abandoned`; `previous_state = verified`
- When: reopen called
- Then: row `state = verified`; admin notification fields reset; new admin notification email sent

**TC-REOPEN-03** — Re-opens `abandoned` (previous=provisioning) to `provisioning`; preserves provision steps

- Given: row `state = abandoned`; `previous_state = provisioning`; `provision_state.graduated = done`; `provision_state.idp_user = dead`
- When: reopen called
- Then: row `state = provisioning`; `reconciler_claimed_at` cleared; `provision_state.graduated` remains `done`; dead steps may be reset; reconciler picks up remaining steps on next run

**TC-REOPEN-04** — Non-abandoned row → 409 `NOT_ABANDONED`

- Given: row `state = verified`
- When: reopen called
- Then: HTTP 409 `{ "error": "NOT_ABANDONED" }`; row unchanged

**TC-REOPEN-05** — Unknown registration ID → 404

- When: reopen called with random UUID
- Then: HTTP 404

**TC-REOPEN-06** — `previous_state` null falls back to `submitted`

- Given: row `state = abandoned`; `previous_state = null` (edge case: abandoned at first submit)
- When: reopen called
- Then: row re-opens to `submitted`; no error

**TC-REOPEN-07** — OTel event emitted on re-open

- When: reopen succeeds
- Then: OTel `registration.state_transition` event emitted with `actor = admin`, `reason = admin_reopened` (or supplied reason), `from_state = abandoned`, `to_state = <targetState>`

**TC-REOPEN-08** — Optional `reason` stored in OTel event

- When: reopen called with `{ "reason": "Operator confirmed identity out-of-band" }`
- Then: OTel event carries the provided reason

---

## TC-ADMIN-LIST — Admin List Endpoint (`GET /admin/.../registration`)

**TC-LIST-01** — Returns paginated list of registrations

- Given: 50 registrations in database
- When: `GET /admin/v1/aggregator/registration?page=1&limit=20`
- Then: HTTP 200 `{ items: [20 rows], total: 50, page: 1, limit: 20 }`

**TC-LIST-02** — Filter by state

- Given: 10 `submitted`, 5 `verified`, 3 `active`
- When: `?state=verified`
- Then: 5 items returned; all with `state = verified`

**TC-LIST-03** — Sort by `updated_at` descending

- When: `?sort=updated_at&order=desc`
- Then: items ordered newest-updated first

**TC-LIST-04** — Sort by `created_at` ascending

- When: `?sort=created_at&order=asc`
- Then: items ordered oldest-created first

**TC-LIST-05** — Empty database → 200 with empty items array

- Given: no registrations
- When: list called
- Then: `{ items: [], total: 0, page: 1, limit: 20 }`

**TC-LIST-06** — Default pagination applied when params omitted

- When: `GET /admin/v1/aggregator/registration` (no params)
- Then: `page = 1`, `limit = 20` defaults applied

---

## TC-ADMIN-GET — Admin Get Single (`GET /admin/.../registration/:id`)

**TC-ADMIN-GET-01** — Returns registration with `latest_admin_note` and `previous_state`

- Given: row with `latest_admin_note = "Looks good."` and `previous_state = verified`
- When: `GET /admin/v1/aggregator/registration/:id`
- Then: response includes `registration.latest_admin_note = "Looks good."` and `registration.previous_state = verified"`

**TC-ADMIN-GET-02** — `latest_admin_note` is null for never-decided registration

- Given: row `state = submitted`; no decision yet
- When: get called
- Then: `registration.latest_admin_note = null`

**TC-ADMIN-GET-03** — Unknown ID → 404

- When: get called with random UUID
- Then: HTTP 404

**TC-ADMIN-GET-04** — Response does NOT include a `transitions` array

- When: get called
- Then: no `transitions` key in the response body (full history in observability backend)

---

## TC-OTEL — OpenTelemetry Event Emission

**TC-OTEL-01** — OTel event emitted on every `store.transition()` call

- When: any FSM transition occurs (submit, verify, approve, decline, abandon)
- Then: one `registration.state_transition` OTel event emitted per transition

**TC-OTEL-02** — All core attributes present on every event

- When: any transition occurs
- Then: event has: `event.name`, `registration.id`, `registration.from_state`, `registration.to_state`, `registration.actor`, `registration.reason`, `registration.org_name`, `registration.version`

**TC-OTEL-03** — `registration.admin_note` present on approve and decline events

- When: admin approves with a note
- Then: `registration.admin_note` attribute is set in the OTel event

**TC-OTEL-04** — `registration.admin_note` absent on non-admin transitions

- When: applicant submits, verifies, or reconciler abandons
- Then: no `registration.admin_note` attribute in the OTel event

**TC-OTEL-05** — `registration.org_name` used (not `contact_email`) to avoid PII in traces

- When: any transition
- Then: OTel event contains `registration.org_name`; no email, phone, or profile data in attributes

**TC-OTEL-06** — `registration.version` reflects post-transition version

- Given: row version was 3 before transition
- When: transition completes
- Then: OTel event `registration.version = 4`

**TC-OTEL-07** — `registration.reason` is always a value from the canonical slug set

- When: any state-transition event is emitted
- Then: `registration.reason` is one of the canonical slugs (`submitted_new`, `applicant_reopened`, `admin_reopened`, `email_verification`, `approval`, `admin_declined`, `decline_limit_reached`, `ttl_expired`, `provision_complete`) — no free-form values

---

## TC-CAS — Optimistic Locking (CAS)

**TC-CAS-01** — `store.transition()` with correct version succeeds

- Given: row at `version = 5`
- When: transition called with `version = 5`
- Then: transition succeeds; row version becomes 6

**TC-CAS-02** — `store.transition()` with stale version → `STALE_TRANSITION` error

- Given: row at `version = 5` (incremented by a concurrent operation)
- When: transition called with `version = 4` (stale)
- Then: `STALE_TRANSITION` error; row unchanged

**TC-CAS-03** — `STALE_TRANSITION` on verify → caller receives non-2xx or appropriate handling; row not corrupted

- When: two concurrent verify calls for the same row
- Then: first succeeds; second gets `STALE_TRANSITION`; row remains coherent at `verified`

**TC-CAS-04** — `previous_state` updated atomically with state on every transition

- When: `store.transition(id, fromState, toState, ...)` succeeds
- Then: `previous_state = fromState` and `state = toState` written atomically in same UPDATE statement

---

## TC-CONFIG — Configuration and Constraints

**TC-CONFIG-01** — `REGISTRATION_ADMIN_APPROVAL_TOKEN_TTL_HOURS` > `REGISTRATION_STUCK_TTL_HOURS`: admin link arrives after row abandoned

- Given: admin token TTL = 200 h; stuck TTL = 168 h; row abandoned after 170 h; admin clicks link at 175 h
- When: decision endpoint called
- Then: HTML "already decided" page (row is `abandoned`); no state mutation; no error

**TC-CONFIG-02** — Multi-admin config: all listed emails receive the notification

- Given: `NETWORK_FACILITATOR_ADMIN_EMAILS = "a@x.com,b@x.com,c@x.com"`
- When: admin notification sent
- Then: one email sent to each of the three addresses

**TC-CONFIG-03** — Empty `NETWORK_FACILITATOR_ADMIN_EMAILS`: admin notification step fails gracefully

- Given: config has empty admin emails list
- When: `ensureAdminNotify` runs
- Then: step marked `failed` (no addresses to send to); logged as warning; reconciler can retry when config is fixed

**TC-CONFIG-04** — `REGISTRATION_MAX_DECLINE_COUNT = 1`: first decline immediately abandons

- Given: `REGISTRATION_MAX_DECLINE_COUNT = 1`; row `decline_count = 0`
- When: admin declines
- Then: row transitions to `abandoned` on this first decline

---

## TC-IDP — IdP Adapter Abstraction

**TC-IDP-01** — All provisioning logic uses `IdpAdminAdapter` interface, not Keycloak directly

- When: code review / architecture test
- Then: no import of Keycloak SDK in provisioning step files; all calls go through `IdpAdminAdapter` methods

**TC-IDP-02** — Swapping the adapter implementation does not change provisioning test outcomes

- Given: `IdpAdminAdapter` implemented by a test fake (not Keycloak)
- When: all provisioning step tests run using the fake
- Then: same pass/fail results as with a Keycloak-backed fake

**TC-IDP-03** — `createUser`, `findByEmail`, `findById`, `enableUser`, `disableUser`, `deleteUser`, `setAttributes` all exercised by provisioning scenarios

- When: all provisioning test cases run
- Then: each adapter operation called at least once across the test suite

---

## TC-DEDUP — Fingerprint and Idempotency

**TC-DEDUP-01** — SHA-256 fingerprint of email + phone + orgName is deterministic

- When: fingerprint computed twice with the same normalised inputs
- Then: identical `idempotency_key` both times

**TC-DEDUP-02** — Different email → different idempotency key → different row

- When: two submissions with different emails but same phone + orgName
- Then: two separate `registrations` rows

**TC-DEDUP-03** — Different phone → different row

- When: two submissions with same email but different phone
- Then: two rows

**TC-DEDUP-04** — Different orgName → different row

- When: same email + phone, different `name`
- Then: two rows

**TC-DEDUP-05** — All `ensure-*` step guards prevent re-execution

- Given: `provision_state[key] = done`
- When: corresponding `ensure-*` function called
- Then: function returns immediately without calling any external service; `provision_state` unchanged

**TC-DEDUP-06** — `aggregators.source_registration_id` prevents duplicate graduation

- Given: `aggregators` row exists with `source_registration_id = X`
- When: `ensureGraduated` called again with same `source_registration_id = X`
- Then: existing row returned; no INSERT; `provision_state.graduated = done`

---

## TC-PRIVACY — Privacy and Probe Prevention

**TC-PRIVACY-01** — All non-active states return 202 on re-submit (no state leakage)

- Given: registrations in `submitted`, `verified`, `provisioning`, `declined`, `abandoned` states
- When: identical forms re-submitted for each
- Then: all return HTTP 202; no body difference that reveals state

**TC-PRIVACY-02** — `active` state intentionally breaks the pattern with 200

- Given: registration `state = active`
- When: identical form submitted
- Then: HTTP 200 `{ "status": "already_active" }`; applicant already knows they're registered

**TC-PRIVACY-03** — Retained PII is access-controlled and flagged for at-rest encryption (planned)

- Given: an abandoned row retains `contact_email` / `contact_phone` / `profile_draft` in plaintext (MVP)
- When: the data-protection posture is reviewed
- Then: the `registrations` table is reachable only via infrastructure access controls; the design documents field-level encoding/encryption at rest as the planned mitigation (purge is intentionally not used)

---

# Review Addendum — Additional Scenarios & Design Follow-ups

The cases below were added after a gap review of the first 171. Two of them surfaced **design ambiguities** — both have since been **resolved in `registration-design.md`** and the resolutions are reflected in the cases below.

> **[DESIGN FOLLOW-UP A — RESOLVED] — `provisioning → active` ordering.** Previously `ensureGraduated` performed the `provisioning → active` transition, but the reconciler **skips `active` rows** (TC-REC-05) — so a failure in `ensureIdpUser` / `ensureSignalstackOrg` / `ensureWelcomeSent` after graduation could never be retried. **Resolution:** a dedicated `ensureActivated` step now performs the transition, gated on `idp_user`, `ss_org`, and `welcome` all being `done`. `ensureGraduated` only creates the `aggregators` row (`status = pending`) and mints `aggregator_id`; `ensureActivated` flips both the registration to `active` and `aggregators.status` to `active` atomically. TC-PROV-ORDER-01..03 encode this.
>
> **[DESIGN FOLLOW-UP B — RESOLVED] — JWT action scope.** **Resolution:** the JWT is **intent-scoped** — the approve and decline links carry distinct tokens with an embedded `intent` claim. The decision endpoint rejects a token whose `intent` does not match the request `decision` with `403 INTENT_MISMATCH`. The URL `intent` param is presentation-only. TC-TOKEN-03/04/07 encode this.

---

## TC-RESUBMIT — Fix-and-Resubmit After Decline (core decline-recovery loop)

The fingerprint is `email + phone + orgName`. An applicant correcting a decline reason typically edits _other_ fields (URL, locations, type, profile) — so the fingerprint is unchanged and the **same row** must be re-opened with the **updated payload**.

**TC-RESUBMIT-01** — Re-submit after decline with corrected `url` updates `profile_draft` on the same row

- Given: row `state = declined`, declined because `org_url` was unreachable; same email + phone + orgName
- When: applicant re-submits with a corrected `url` and otherwise identical fields
- Then: same row (same `idempotency_key`); `state → submitted`; `profile_draft` and `org_url` updated to the new values; `decline_count` unchanged; new verification email sent

**TC-RESUBMIT-02** — Re-submit with corrected `locations` updates the row's locations

- Given: row `state = declined`
- When: re-submit with a new `locations` array
- Then: `org_locations` and `profile_draft` reflect the new locations; same row re-opened

**TC-RESUBMIT-03** — Re-submit with a changed fingerprint field (email) creates a NEW row, leaving the old one declined

- Given: row `state = declined` for `old@x.com`
- When: applicant re-submits with `new@x.com` (phone + orgName unchanged)
- Then: a new `registrations` row is created (different `idempotency_key`); the old declined row is untouched; `decline_count` on the new row starts at 0

**TC-RESUBMIT-04** — Updated `profile_draft` from re-submit is what gets provisioned on later approval

- Given: declined row re-submitted with corrected data; later verified and approved
- When: `ensureSignalstackOrg` runs
- Then: the org is registered in Signals-DPG using the corrected `profile_draft`, not the original payload

**TC-RESUBMIT-05** — Re-submit on an `active` row with changed non-fingerprint fields does NOT mutate the live aggregator

- Given: row `state = active`
- When: identical fingerprint re-submitted with a different `url`
- Then: HTTP 200 `{ "status": "already_active" }`; `profile_draft` and the `aggregators` row are NOT modified (updates to a live aggregator go through a separate authenticated path, not the public submit endpoint)

**TC-RESUBMIT-06** — Re-submit refreshes the `consent` block

- Given: a `declined` row with stored consent `given_at = T1`
- When: applicant re-submits (same fingerprint) with a new consent block `given_at = T2`
- Then: the row's stored `consent` is updated to the T2 block; the most recent consent governs at re-entry

---

## TC-SUBMIT-EXT — Submission Edge Cases

**TC-SUBMIT-EXT-01** — Concurrent identical submissions race on the unique `idempotency_key`

- Given: no existing row; two identical submissions arrive simultaneously
- When: both attempt to INSERT
- Then: exactly one row is created; the loser catches the unique-constraint violation and returns 202 (treated as a dedupe replay), not 500; only one verification email sent

**TC-SUBMIT-EXT-02** — Database unavailable on submit → 5xx, no partial row

- Given: the database is unreachable
- When: `POST .../create`
- Then: HTTP 5xx; no row persisted; no verification email sent (write-first principle: side effects never precede the committed write)

**TC-SUBMIT-EXT-03** — Empty `locations` array → 400 (or documented default)

- When: submit with `"locations": []`
- Then: behaviour matches the schema contract — 400 if locations are required, or accepted if optional; assert the documented choice explicitly

**TC-SUBMIT-EXT-04** — Optional `type` omitted → stored as documented default

- When: submit without `type`
- Then: row created; `org_type` set to the documented default (or null) — assert the chosen behaviour

**TC-SUBMIT-EXT-05** — Oversized `profile_draft` payload → 400 (request body size guard)

- When: submit with a payload exceeding the configured max body size
- Then: HTTP 400/413; no row created; no unbounded write

**TC-SUBMIT-EXT-06** — Leading/trailing whitespace in `orgName` is trimmed before fingerprinting

- Given: no prior row
- When: submit `"name": "  My NGO  "` then `"name": "My NGO"`
- Then: same `idempotency_key`; single row (consistent with email/phone normalisation)

---

## TC-CONSENT — Consent Validation

**TC-CONSENT-01** — `consent.valid_till` in the past → 400

- When: submit with `valid_till` earlier than now
- Then: HTTP 400; no row created (cannot register with already-expired consent)

**TC-CONSENT-02** — `consent.given_at` in the future → 400

- When: submit with `given_at` later than now
- Then: HTTP 400

**TC-CONSENT-03** — `consent.given_at` after `consent.valid_till` → 400

- When: submit with `given_at` later than `valid_till`
- Then: HTTP 400

**TC-CONSENT-04** — Valid consent window → accepted

- When: `given_at` ≤ now ≤ `valid_till`
- Then: HTTP 202; consent block stored verbatim

---

## TC-PROV-ORDER — Provisioning Step Ordering [DESIGN FOLLOW-UP A]

**TC-PROV-ORDER-01** — Row reaches `active` only after all four approval steps are `done`

- Given: approved row in `provisioning`; `ensureGraduated`, `ensureIdpUser`, `ensureSignalstackOrg` done but `ensureWelcomeSent` failed
- When: provisioning state inspected
- Then: row is still `provisioning` (NOT `active`); reconciler will retry `welcome`

**TC-PROV-ORDER-02** — `ensureGraduated` runs before `ensureIdpUser` (aggregator_id dependency)

- Given: approved row; nothing provisioned yet
- When: inline provisioning runs
- Then: `aggregator_id` is created by `ensureGraduated` and is available when `ensureIdpUser.setAttributes` writes it to the IdP profile

**TC-PROV-ORDER-03** — A failed step on an otherwise-graduated row is still retried (regression guard for the active-skip bug)

- Given: `ensureGraduated = done`, `aggregators` row exists, but `provision_state.ss_org = failed`; row state is `provisioning`
- When: reconciler runs
- Then: `ensureSignalstackOrg` is retried (row is not yet `active`, so it is not skipped); on success the row transitions to `active`

**TC-PROV-ORDER-04** — `org_slug` collision between two different organisations is disambiguated

- Given: an `aggregators` row already exists with `org_slug = "my-ngo"` (different `source_registration_id`)
- When: a second, different org whose name also derives to `"my-ngo"` graduates
- Then: graduation succeeds with a disambiguated slug (e.g. `my-ngo-2`); no unique-constraint failure; graduation is not blocked

---

## TC-TOKEN — JWT Scope, Audience & Reuse [DESIGN FOLLOW-UP B]

**TC-TOKEN-01** — Verification JWT cannot be used on the admin decision endpoint

- Given: a valid verification-link JWT
- When: submitted to `POST .../decision/:id`
- Then: rejected (wrong audience/scope); no state change

**TC-TOKEN-02** — Admin approval JWT cannot be used on the verify endpoint

- Given: a valid admin approval JWT
- When: submitted to `GET .../verify`
- Then: 400 `TOKEN_INVALID`; no state change

**TC-TOKEN-03** — Approve-intent JWT used with `decision: "decline"` is rejected (if tokens are intent-scoped)

- Given: JWT issued for `intent = approve`
- When: `POST .../decision` with `{ decision: "decline" }`
- Then: HTTP 403 `{ "error": "INTENT_MISMATCH" }`; no state change

**TC-TOKEN-04** — Decline-intent JWT used with `decision: "approve"` is rejected

- Given: JWT issued for `intent = decline`
- When: `POST .../decision` with `{ decision: "approve" }`
- Then: HTTP 403 `{ "error": "INTENT_MISMATCH" }`; no state change

**TC-TOKEN-05** — Admin token reused after a re-open (version changed) is rejected by CAS

- Given: admin approval JWT issued; row later abandoned then re-opened (version incremented)
- When: admin clicks the old approval link
- Then: CAS version check fails or the row is no longer in `verified`; served an "already decided"/stale page; no double action

**TC-TOKEN-06** — Verification token issued before re-open still verifies the re-opened `submitted` row if within TTL

- Given: row re-opened to `submitted`; the applicant holds a still-valid pre-existing verification token (new one also sent)
- When: the old token is clicked
- Then: verification succeeds idempotently against the current `submitted` row (or returns `TOKEN_INVALID` if the design rotates the token secret on re-open) — assert the documented behaviour

**TC-TOKEN-07** — Tampered `intent` query param does not change the authorised action

- Given: JWT issued for `intent = approve`
- When: `GET .../read/:id?token=<approve-jwt>&intent=decline`
- Then: the page reflects the JWT's authorised intent, not the URL param; the URL param alone cannot escalate to a different action

---

## TC-SECURITY — Injection & Capability-Token Hardening

**TC-SECURITY-01** — Admin note with HTML/script is escaped in the confirmation result page

- Given: decline note `"<script>alert(1)</script> fix your url"`
- When: the decision result HTML page is rendered
- Then: the note is HTML-escaped; no executable markup in the response

**TC-SECURITY-02** — Admin note with HTML/script is escaped/sanitised in the applicant email

- Given: decline note containing HTML
- When: `ensureDeclineSent` builds the email
- Then: the note is rendered safely (escaped in HTML email body / plain in text part); no injection into the email template

**TC-SECURITY-03** — Whitespace-only decline note → 400 `NOTE_REQUIRED`

- When: decline with `note: "   "`
- Then: HTTP 400 `NOTE_REQUIRED` (note is trimmed before the required-check); no state change

**TC-SECURITY-04** — Note length check is applied after trimming

- When: decline with 500 visible chars plus surrounding whitespace
- Then: trimmed length ≤ 500 is accepted; raw length > 500 alone does not falsely reject

**TC-SECURITY-05** — Status endpoint does not allow enumeration

- Given: a sequence of guessed/sequential UUIDs
- When: `GET .../status/:id` called for non-existent IDs
- Then: 404 for all; no timing or response difference that distinguishes "exists but not yours" from "does not exist" (the UUID is the only capability)

**TC-SECURITY-06** — `org_name` is the only org identifier in OTel attributes; no email/phone leaks to traces

- When: any transition emits an OTel event
- Then: attributes contain no `contact_email`, `contact_phone`, or `profile_draft` content (re-asserts TC-OTEL-05 as a security invariant)

**TC-SECURITY-07** — Admin endpoints are unreachable without the gateway service auth (contract test)

- Given: a request bypassing the gateway (direct to the service) without the service API key
- When: any `/admin/**` route is called
- Then: rejected per the gateway contract — documented so the gateway policy and the service agree on the boundary

---

## TC-RECONCILE-EXT — Reconciler Robustness

**TC-REC-EXT-01** — Reconciler releases (or TTL-expires) its claim when a step throws

- Given: a claimed row whose `ensure-*` step throws an unexpected error
- When: the run handles the error
- Then: the claim is released (or left to expire via the 10-min TTL); the next reconciler run can re-process the row; the error is logged, not swallowed

**TC-REC-EXT-02** — A single failing row does not abort the whole reconcile pass

- Given: 5 reconcilable rows; row 3 throws during a step
- When: reconciler runs
- Then: rows 1, 2, 4, 5 are still processed; row 3 is counted under `warnings`; the response totals are consistent

**TC-REC-EXT-03** — Reconciler is idempotent across back-to-back runs

- Given: a row fully repaired by run A
- When: run B executes immediately after
- Then: no duplicate emails/accounts; all `ensure-*` guards short-circuit; `repaired` count for that row is 0 in run B

**TC-REC-EXT-04** — Reconciler abandons a `provisioning` row with a `dead` step once past the stuck TTL

- Given: row `state = provisioning`, `provision_state.idp_user = dead`, age > `REGISTRATION_STUCK_TTL_HOURS`
- When: reconciler runs
- Then: row transitions to `abandoned` (TTL wins over a dead step); data retained (no purge)

**TC-REC-EXT-05** — TTL boundary is exclusive/inclusive as documented

- Given: row exactly at `REGISTRATION_UNVERIFIED_TTL_HOURS` to the second
- When: reconciler runs
- Then: abandon decision matches the documented boundary semantics (e.g. `age > TTL` strictly) — assert the exact boundary

---

## TC-REOPEN-EXT — Re-open Interactions

**TC-REOPEN-EXT-01** — Re-open a decline-limit-abandoned row restores `verified` with `decline_count` at max

- Given: row abandoned via the Nth decline (`decline_count = REGISTRATION_MAX_DECLINE_COUNT`); `previous_state = verified`
- When: admin re-opens
- Then: row `state = verified`; `decline_count` unchanged (still at max); admin may now approve

**TC-REOPEN-EXT-02** — After re-opening a decline-limit row, one more decline immediately re-abandons

- Given: re-opened row from TC-REOPEN-EXT-01 (`decline_count` at max, `state = verified`)
- When: admin declines again
- Then: row transitions straight to `abandoned`; `decline_count` incremented past max

**TC-REOPEN-EXT-03** — Re-open of an abandoned row works directly (data retained, no purge)

- Given: an `abandoned` row with retained contact data; `previous_state = submitted`
- When: admin re-opens to `submitted`
- Then: the row is `submitted` with its original `contact_email` intact; a verification email is sent to the real address with no sentinel problem (the purge-related re-open hazard no longer exists)

**TC-REOPEN-EXT-04** — Concurrent re-open and re-submit on the same abandoned row do not double-open

- Given: abandoned row; an admin re-open and an applicant re-submit arrive together
- When: both attempt the `abandoned → submitted` transition
- Then: CAS lets exactly one win; the other is a safe no-op/202; the row ends in a single coherent `submitted` state

---

## TC-STATUS-EXT — Status Endpoint Remaining States

**TC-STATUS-EXT-01** — `provisioning` state reported without exposing internal provision step detail

- Given: row `state = provisioning`
- When: status called
- Then: `{ state: "provisioning", can_resubmit: false }`; no `provision_state` internals leaked to the public response

**TC-STATUS-EXT-02** — `verified` state reports `can_resubmit: false`

- Given: row `state = verified`
- When: status called
- Then: `{ state: "verified", can_resubmit: false, decline_count: <n> }`

**TC-STATUS-EXT-03** — `active` state reports the approval note if one was given

- Given: row `state = active`, approved with a note
- When: status called
- Then: `{ state: "active", admin_note: "<note>", can_resubmit: false }`
