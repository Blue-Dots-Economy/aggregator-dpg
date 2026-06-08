# Per-Link Submission Mode (`account_only` vs `account_and_profile`)

> **Status:** Design (brainstormed 2026-06-08)
> **Scope:** `aggregator-dpg` only. No signals API changes.
> **Depends on:** `feat/aggregator-onboarding-lifecycle-followup` (`submit_mode` plumbing, `lifecycle_status` resolver, `outbound_dispatch_log`).
>
> **Naming note:** the column is named **`submission_mode`** (not `onboarding_mode`) to avoid collision with the existing `OnboardingConfigSchema.modes` concept in `packages/schema-service/src/onboarding.schema.ts`, where "onboarding mode" means the **delivery channel** (`bulk` / `qr` / `link`). `submission_mode` mirrors signals' existing `submit_mode` enum vocabulary and refers to the **shape of the form submission** the link expects.

---

## 1. Problem

Today every `registration_links` row implicitly assumes the public form will collect **both** account identity AND a full profile payload. The new lifecycle work added a per-submission `partial: true` checkbox so end-users can opt into account-only landing, but that decision is user-driven at submit time. Aggregators want to lock a link to one shape:

- **Walk-in / event-table flow** — collect only name + phone or email, fast capture, profile completion happens later via a different channel.
- **Full registration flow** — current behavior: identity + complete profile in one submit.

Today a "walk-in only" intent leaks: the form still renders the full RJSF profile schema and the user can submit extra data, and the dispatcher may fire outbound campaigns the aggregator did not configure.

## 2. Goals

- Per-link mode set at creation time: `account_only` | `account_and_profile`.
- Server enforces the mode on every submit; client renders matching shape.
- Mode is **immutable** after creation — admins create a new link to change shape.
- `account_only` links **never** trigger the outbound dispatcher.
- Fully back-compat: existing rows + existing API callers stay on `account_and_profile`.

## 3. Non-goals (deferred)

- Admin UI for the toggle. API-only in this spec. UI is a follow-up.
- New `kyc_only` / `identity_only_no_name` / etc. modes. Enum is extensible but only two values land here.
- Cross-link analytics ("conversion rate by mode"). Future spec.
- Re-mode (changing mode on an existing link). Explicitly rejected.

## 4. State model

### 4.1 New column on `registration_links`

```sql
ALTER TABLE registration_links
  ADD COLUMN IF NOT EXISTS submission_mode text NOT NULL DEFAULT 'account_and_profile'
    CHECK (submission_mode IN ('account_only', 'account_and_profile'));
```

Drizzle:

```ts
submissionMode: text('submission_mode')
  .notNull()
  .default('account_and_profile')
  .$type<'account_only' | 'account_and_profile'>(),
```

Additive. Every existing row gets `'account_and_profile'` — no behaviour change for unmodified links.

### 4.2 Relationship to existing fields

| Field                                  | Account_only link                                | Account_and_profile link         |
| -------------------------------------- | ------------------------------------------------ | -------------------------------- |
| `completion_actions[]`                 | **Forbidden** (empty array enforced at create)   | Optional, fires on `draft`       |
| `partial: true` body flag              | Ignored (server forces account_only)             | Honored (existing behaviour)     |
| `item_state` body field                | **Rejected** with `400 SUBMISSION_MODE_MISMATCH` | Required when `partial !== true` |
| `lifecycle_status` returned by signals | `null` (no item)                                 | `'draft'` or `'live'`            |
| Dispatcher fan-out                     | **Skipped**                                      | Fires on `draft`                 |

## 5. Admin endpoints

### 5.1 `POST /admin/v1/registration-links` (create)

New optional body field:

```jsonc
{
  // ... existing fields ...
  "submission_mode": "account_only" | "account_and_profile",   // defaults to "account_and_profile"
  "completion_actions": []                                      // must be empty when account_only
}
```

Validation:

- Default to `'account_and_profile'` if omitted.
- If `submission_mode === 'account_only'` AND `completion_actions.length > 0` → `400 INVALID_CONFIG` with `detail: "completion_actions are not allowed on account_only links"`.

### 5.2 `PATCH /admin/v1/registration-links/:id` (update)

If body contains `submission_mode` → `400 SUBMISSION_MODE_IMMUTABLE` with `detail: "submission_mode cannot be changed after link creation"`.

(`completion_actions` editability is unchanged by this spec.)

## 6. Public link resolve

### 6.1 `GET /public/v1/aggregators/:org/links/:slug`

Add `submission_mode` to the response:

```jsonc
{
  "slug": "walk-in-2026",
  "network": "blue_dot",
  "domain": "seeker",
  "context": { ... },
  "submission_mode": "account_only",  // NEW
  "schema_id": "...",
  "schema_version": "...",
  "schema": null,                     // explicit null when account_only (field shape stays stable for back-compat clients)
  "identity": { ... },
  "expires_at": null
}
```

When `submission_mode === 'account_only'`, `schema` is set to explicit **`null`** in the response (the form will not render it). Saves bytes and prevents the client from rendering a profile form for an account-only link even by accident. Existing clients that expected a non-null `schema` must be tolerant of `null` — the only place that reads it is the public form, which already branches on submission_mode after this PR.

## 7. Public submit

### 7.1 `POST /public/v1/aggregators/:org/registrations/:slug`

Behavior gates on `link.submissionMode`:

**`account_only` branch:**

1. Validate body matches identity-only shape: `name` (required string) + at least one of `phone_number` / `email` (required) + consent flags (required). `partial` is **accepted and ignored** (treated as `true` regardless of value). `item_state` or any other field → `400 SUBMISSION_MODE_MISMATCH` with `detail: "account_only link does not accept item_state or profile fields"`.
2. Force `submit_mode = 'account_only'` regardless of the body's `partial` flag.
3. Call `signalstack.onboard({ submit_mode: 'account_only', ... })`.
4. **Skip the dispatcher fan-out entirely** — no `planCompletionDispatch` call, no `outbound_dispatch_log` rows.
5. Return the standard response shape with `lifecycle_status: null`, `completion_pct: null`.

**`account_and_profile` branch:** unchanged behavior. `partial: true` continues to map to `submit_mode: 'account_only'` for the per-submit opt-in.

### 7.2 Error codes

| Code                        | HTTP | When                                                                  |
| --------------------------- | ---- | --------------------------------------------------------------------- |
| `SUBMISSION_MODE_MISMATCH`  | 400  | account_only link receives a body with `item_state` or profile fields |
| `INVALID_CONFIG`            | 400  | account_only link create body has `completion_actions.length > 0`     |
| `SUBMISSION_MODE_IMMUTABLE` | 400  | PATCH includes `submission_mode`                                      |

## 8. Web form

### 8.1 `apps/web/src/app/[org]/[slug]/page.tsx`

Pass `submission_mode` (from the resolve response) to `PublicRegistrationView` as a prop. No new fetch.

### 8.2 `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`

Top-level branch on the prop:

- `account_only` → render `MinimalIdentityForm` (new sub-component): Name input, Phone input, Email input ("provide phone OR email"), consent checkboxes, submit button. No RJSF tree. No `partial:true` checkbox. Submit POSTs identity-only body.
- `account_and_profile` → existing RJSF + identity form + partial-submit checkbox.

The pre-submit `/lookup` probe (owned_elsewhere / resume branches) applies to both modes — same UX, same hide-owning-org guarantees.

### 8.3 i18n

New keys in `apps/web/src/i18n/messages/{en,hi,kn}.json`:

- `Registration.account_only.title` — e.g. "Quick sign-up"
- `Registration.account_only.helper` — e.g. "Provide your name and a contact number or email. You can complete your profile later."
- `Registration.account_only.contact_label` — e.g. "Phone OR email (at least one)"

Existing `Registration.*` strings stay for the full mode.

## 9. Back-compat & rollout

- Single additive migration. Default value keeps all existing rows on `account_and_profile`.
- API callers omitting `submission_mode` on create → defaults to `account_and_profile`. No client changes required.
- Older API builds returning a resolve response without `submission_mode` → web form treats undefined as `account_and_profile` (back-compat fallback, same pattern as `lifecycle_status`).
- Order doesn't matter: aggregator can deploy this independently. No signals coordination needed.

## 10. Testing strategy

**Unit (pure):**

- Create-link validator: rejects `account_only` + non-empty `completion_actions`.
- Update-link validator: rejects any `submission_mode` in body.
- Submit handler: forces `submit_mode: 'account_only'` for account_only link; rejects bodies with `item_state`; skips dispatcher.

**Integration (PG + in-memory fakes):**

- `account_only` link create + submit with identity-only body → 201, no dispatcher rows in `outbound_dispatch_log`.
- `account_only` link create + submit with profile field → 400 `SUBMISSION_MODE_MISMATCH`.
- `account_only` link create with non-empty `completion_actions` → 400 `INVALID_CONFIG`.
- `account_and_profile` link create + submit unchanged (regression).
- PATCH with `submission_mode` → 400 `SUBMISSION_MODE_IMMUTABLE`.

**Web (component + view):**

- `PublicRegistrationView` with `submission_mode='account_only'` → renders identity-only form, no RJSF, no partial checkbox.
- `PublicRegistrationView` with `submission_mode='account_and_profile'` → renders existing full form (regression).
- BFF lookup branches (owned_elsewhere / resume / allow) behave identically across both modes.

**Schema test:**

- Column exists, default, check constraint enforced.

## 11. Migration & backfill

- One additive migration (`0014_submission_mode.sql`).
- No backfill — default keeps existing rows correct.
- Regenerate via `pnpm db:generate:api` (per CLAUDE.md).

## 12. Open questions

None at design time. All decisions locked via brainstorming session (2026-06-08):

1. **Mode names:** `account_only` / `account_and_profile` (matches signals' `submit_mode` enum).
2. **Dispatcher on account_only:** does NOT fire automatically.
3. **Mode editability:** immutable post-creation.
4. **Identity fields:** name + (phone OR email) + consent.
5. **Storage:** explicit enum column (vs boolean / derived).
6. **Enforcement:** hybrid — server enforces, client renders to match.
7. **Completion_actions on account_only links:** forbidden at create time.
8. **Admin UI:** out of scope; API-only.

## 13. Estimated work

- DB migration + Drizzle column + test: 0.5d
- Admin create/update validators + test: 0.5d
- Public resolve response field + test: 0.25d
- Public submit handler branch + tests: 1d
- Web form branch + MinimalIdentityForm + tests + i18n: 1.5d
- Integration sweep + docs: 0.25d

**Total: ~4 person-days.**
