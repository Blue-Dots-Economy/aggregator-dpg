# Φ1 Phase 1 — Registration & Profile — features

> JTBDs: AG-0 (registration + login), AG-0c (schema-driven profile view/edit). One H2 per feature; each becomes a GitHub issue.

---

## F1.1 AG-0 Registration-request landing page + form

**Story:** As a prospective aggregator admin, I want a pre-login page to submit a registration request so the ecosystem team can approve me.

**AC**
- [ ] Public route `/register` in `apps/web`
- [ ] Fields: org name, aggregator type (select, options from `entities.yaml`), admin name, email, phone, T&Cs checkbox, consent checkbox
- [ ] Client validation; submit disabled until valid
- [ ] On success: show confirmation screen ("request received; expect email")
- [ ] A11y: every field labelled, errors via `aria-describedby`

**Config touched:** `entities.yaml` (aggregator type options), `features.yaml` (locale).

**Interfaces touched:** none new in frontend; calls `POST /v1/registration-requests` (F1.2).

**Tests**
- [ ] Unit: form validation schema
- [ ] E2E: happy path submit → confirmation screen (Playwright)

**Tasks**
- [ ] T-1.1.1 Route + page scaffold
- [ ] T-1.1.2 Form component (uses `packages/ui` form primitives)
- [ ] T-1.1.3 Client validation schema
- [ ] T-1.1.4 Confirmation screen
- [ ] T-1.1.5 Playwright happy-path test

**Blocked by:** P-17.1, P-17.2, P-17.5, P-17.7

---

## F1.2 AG-0 `POST /v1/registration-requests` + admin email + persistence

**Story:** As the system, I want to persist registration requests and notify the ecosystem admin so approval can happen out-of-band.

**AC**
- [ ] `POST /v1/registration-requests` accepts payload matching F1.1
- [ ] Server-side Zod validation; typed `ValidationError` returned on failure
- [ ] Persists to `registration_request` table with status `pending`, `consent_at` timestamp
- [ ] Sends email via `EmailService` using template `registration-request-received` to the ecosystem admin alias (from `features.yaml: registration.adminEmail`)
- [ ] Rate-limited: 3/hour/email, 10/hour/IP
- [ ] Audit log entry: `action = "registration-request.submitted"`

**Config touched:** `features.yaml` (admin alias, rate limits).

**Interfaces touched:** `DBService` (write `registration_request`), `EmailService`, `Logger`, `AuditLog`.

**Tests**
- [ ] Unit: validation + rate limiter
- [ ] Integration: POST → DB row + queued email in test sink
- [ ] Integration: rate-limit triggers after N requests

**Tasks**
- [ ] T-1.2.1 Route handler + Zod schema
- [ ] T-1.2.2 Persistence (via repo)
- [ ] T-1.2.3 Email dispatch
- [ ] T-1.2.4 Rate limiting middleware binding
- [ ] T-1.2.5 Audit log call
- [ ] T-1.2.6 Integration tests

**Blocked by:** P-04 (registration_request table), P-10.3 (template), P-12, P-13.6

---

## F1.3 AG-0 Approval-confirmation email template

**Story:** As an approved aggregator admin, I want an email confirming approval so I know I can log in.

**AC**
- [ ] Templates `registration-approved` and `registration-rejected` authored under `packages/email/templates/` with English + Hindi placeholder folders
- [ ] Approval template links to `/login`
- [ ] Sent manually by ecosystem admin (out-of-band) via an admin CLI script in MVP: `pnpm -w admin:send-approval <request-id>`
- [ ] Script marks the `registration_request` row as `status = approved`, writes audit log

**Config touched:** none new.

**Interfaces touched:** `EmailService`, `DBService`, `AuditLog`.

**Tests**
- [ ] Unit: template rendering with variables
- [ ] Integration: admin script updates row + sends email

**Tasks**
- [ ] T-1.3.1 Approved/rejected templates
- [ ] T-1.3.2 Admin CLI script
- [ ] T-1.3.3 Template render tests

**Blocked by:** P-10.3, F1.2

---

## F1.4 AG-0 Login page + OTP + session issuance

**Story:** As an approved aggregator admin, I want to log in with email/phone + OTP so I don't manage a password.

**AC**
- [ ] `/login` page: email-or-phone input → "Send OTP" → OTP input → "Verify"
- [ ] `POST /v1/auth/otp/request` and `/verify` endpoints wired to `AuthService`
- [ ] On verify: lookup `SignalStackClient.findOrgByEmail|Phone` to resolve `aggregator_id`; if not found or not approved, return `AuthError` with code `not-approved`
- [ ] On success: issue access + refresh tokens; frontend stores + redirects to `/`
- [ ] Verify endpoint audit-logged: `action = "login.succeeded"` or `login.failed`

**Config touched:** `auth.yaml` (OTP TTL, rate limits from P-05.6).

**Interfaces touched:** `AuthService`, `SignalStackClient`, `AuditLog`, frontend `Auth context`.

**Tests**
- [ ] Unit: OTP state machine
- [ ] Integration: request → verify → session issued; wrong OTP → error; lockout after N attempts
- [ ] E2E: full login flow (Playwright, with fake OTP provider)

**Tasks**
- [ ] T-1.4.1 `/v1/auth/otp/request` handler
- [ ] T-1.4.2 `/v1/auth/otp/verify` handler + org lookup
- [ ] T-1.4.3 Login page UI + state
- [ ] T-1.4.4 Session attach + redirect
- [ ] T-1.4.5 Not-approved error path
- [ ] T-1.4.6 E2E

**Blocked by:** P-05 (all), P-06.3, P-17.4

---

## F1.5 AG-0c Profile view (dynamic render from `SchemaService`)

**Story:** As an aggregator admin, I want to see my org profile rendered from the canonical schema so what I see matches what the schema says.

**AC**
- [ ] `/profile` page (protected)
- [ ] `GET /v1/profile/schema` returns the active form descriptor from `SchemaService.emitFormDescriptor`
- [ ] `GET /v1/profile` returns stored values from `aggregator_profile` table
- [ ] UI renders read-mode grouped by Who I Am / What I Have / What I Want sections
- [ ] Empty required fields show a muted hint; non-empty fields show their values formatted per type

**Config touched:** `profiles.yaml` (source of schema).

**Interfaces touched:** `SchemaService`, `DBService` (via `AggregatorProfileRepo`), frontend form renderer (P-17.5).

**Tests**
- [ ] Unit: descriptor renderer with fixtures covering every field type
- [ ] Integration: `GET /profile` returns expected shape
- [ ] E2E: logged-in user sees their profile

**Tasks**
- [ ] T-1.5.1 `/v1/profile/schema` endpoint
- [ ] T-1.5.2 `/v1/profile` GET endpoint
- [ ] T-1.5.3 Read-mode page
- [ ] T-1.5.4 Section grouping
- [ ] T-1.5.5 E2E

**Blocked by:** P-14 (all), P-04.4.1–.2, P-17.5

---

## F1.6 AG-0c Profile edit + save (Aggregator DB)

**Story:** As an aggregator admin, I want to edit my org profile so my information stays current.

**AC**
- [ ] Edit mode toggled from F1.5 page
- [ ] `PATCH /v1/profile` with partial values; Zod-validated against the active schema
- [ ] Server-side writes to `aggregator_profile.values_json`; bumps `updated_at`; records audit log entry `action = "profile.updated"` with diff
- [ ] Optimistic UI: save → 200 → revert to read-mode; failure → keep edit state + error banner
- [ ] MVP constraint: contact-detail changes do NOT propagate to Signals Stack (banner notes this)

**Config touched:** `profiles.yaml`.

**Interfaces touched:** `SchemaService.computeCompletionPct` (for post-save display), `DBService`, `AuditLog`.

**Tests**
- [ ] Unit: partial-values validator
- [ ] Integration: PATCH writes values, audit log captures diff
- [ ] E2E: edit → save → revert to read mode with new values

**Tasks**
- [ ] T-1.6.1 `PATCH /v1/profile` handler + validator
- [ ] T-1.6.2 Edit-mode UI
- [ ] T-1.6.3 Optimistic update + error state
- [ ] T-1.6.4 "Not propagated to Signals Stack" banner
- [ ] T-1.6.5 Audit diff
- [ ] T-1.6.6 E2E

**Blocked by:** F1.5, P-13.6

---

## F1.7 AG-0c Verified-flag surfacing

**Story:** As an aggregator admin, I want to see a "Verified" badge so I know my org is verified upstream.

**AC**
- [ ] `GET /v1/me` returns `{ aggregator_id, name, verified: boolean }` from Signals Stack via `SignalStackClient`
- [ ] Badge on profile page when `verified = true`
- [ ] Cached for 60 s per aggregator

**Config touched:** `signal-stack.yaml` (lookup endpoint).

**Interfaces touched:** `SignalStackClient`, `CacheService`.

**Tests**
- [ ] Unit: cache behaviour (miss → hit within TTL)
- [ ] Integration: verified flag round-trip from mock Signal Stack
- [ ] E2E: badge visible when Signals Stack reports verified

**Tasks**
- [ ] T-1.7.1 `/v1/me` endpoint
- [ ] T-1.7.2 Cache wrapper
- [ ] T-1.7.3 Badge component
- [ ] T-1.7.4 E2E

**Blocked by:** P-06.3, P-12

---

## F1.8 i18n scaffolding + English copy externalisation

**Story:** As a product team, I want all strings externalised so Hindi + regional locales can be added without code changes.

**AC**
- [ ] `apps/web/messages/en.json` authored for every Phase-1 page
- [ ] `apps/web/messages/hi.json` exists (empty values; placeholder)
- [ ] next-intl active; `t()` used in every component added in Phase 1
- [ ] Locale switcher hidden until > 1 locale has copy
- [ ] CI check: no hardcoded user-visible strings (custom lint rule)

**Config touched:** `features.yaml: availableLocales`.

**Interfaces touched:** next-intl provider (P-17.7).

**Tests**
- [ ] Unit: lint rule catches a hardcoded string
- [ ] Integration: switching locale renders translated strings

**Tasks**
- [ ] T-1.8.1 Extract Phase-1 copy to `en.json`
- [ ] T-1.8.2 `hi.json` placeholder
- [ ] T-1.8.3 Hardcoded-string lint rule
- [ ] T-1.8.4 Locale switcher visibility gate

**Blocked by:** P-17.7
