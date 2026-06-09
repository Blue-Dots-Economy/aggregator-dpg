# Per-Link `registration_mode` (config-driven, supersedes `submission_mode`)

> **Status:** Design (brainstormed 2026-06-09)
> **Scope:** `aggregator-dpg` only. No signals API changes.
> **Supersedes:** `2026-06-08-per-link-submission-mode-design.md` (the `submission_mode` work on the same branch).
> **Branch:** `feat/account-only-onboarding-mode` (still draft PR #401 — supersedes the submission_mode commits there).

---

## 1. Problem

The current `submission_mode` field conflates two concerns: **how** a participant is onboarded (in-person via a voice call vs. self-service form) and **what data** the form collects (identity only vs. identity + full profile). Form shape is a _consequence_ of channel choice, not a peer field.

Admins reason about channel ("we run a voice campaign in district X this week, then a self-service form drive next week"), not about submission shape. They also need extensibility: SMS campaigns, WhatsApp campaigns, kiosk capture — each a distinct admin-facing mode, each ultimately mapping to one of two form shapes the renderer supports.

Hard-coding the enum of admin-facing modes in the DB means every new channel becomes a migration. Putting the mode list in config keeps the DB stable.

## 2. Goals

- Rename `submission_mode` → `registration_mode` to reflect that the value names a channel, not a form shape.
- Move the mode enum and its mapping to form shape into per-network config (`config/<network>/aggregator.config.yaml`). Adding `sms_campaign` / `kiosk` later = config edit + i18n keys, no migration.
- Two modes ship today: `voice`, `form`.
- Voice mode: form is identity-only; below the form, a hint announces the follow-up call. No automatic outbound dispatcher (out-of-band).
- Form mode: full RJSF profile renders; the server silently accepts partial submissions (no opt-in checkbox).
- Mode is immutable post-creation; existing links — there are no production rows, so we drop the old column cleanly.

## 3. Non-goals (deferred)

- Automatic outbound voice dispatcher when `voice` mode is chosen (the existing `completion_actions[]` mechanism handles it if explicitly configured; voice mode does NOT auto-wire actions).
- Real outbound vendor adapters (Twilio, etc. — still stubbed).
- SMS / WhatsApp / kiosk modes (only `voice` + `form` land here; the config schema accepts more, but the form-renderer only knows two submission shapes).
- Counterparty notifications when signals auto-cancels a pending action.

## 4. State model

### 4.1 `registration_modes` block in `aggregator.config.yaml`

Per-network. Lives inside the existing `aggregator:` root.

```yaml
aggregator:
  # ... existing fields (name, network, brand, onboarding, ...) ...
  registration_modes:
    voice:
      label_i18n_key: registration_mode.voice.label
      submission_shape: account_only
      public_hint_i18n_key: registration_mode.voice.hint
    form:
      label_i18n_key: registration_mode.form.label
      submission_shape: account_and_profile
      public_hint_i18n_key: null
```

**Schema (Zod):**

| Field                  | Required      | Shape                                                                          |
| ---------------------- | ------------- | ------------------------------------------------------------------------------ |
| (key)                  | yes           | matches `^[a-z][a-z0-9_]*$`                                                    |
| `label_i18n_key`       | yes           | string, identifies the i18n key the admin form renders for the dropdown option |
| `submission_shape`     | yes           | enum: `account_only` \| `account_and_profile`                                  |
| `public_hint_i18n_key` | no (nullable) | string, identifies the i18n key shown beneath the public form                  |

A network must declare at least one mode. The dropdown's default is the first key in declared order.

### 4.2 DB

```sql
ALTER TABLE registration_links DROP COLUMN submission_mode;
ALTER TABLE registration_links
  ADD COLUMN registration_mode text NOT NULL DEFAULT 'form'
    CHECK (registration_mode ~ '^[a-z][a-z0-9_]*$');
```

`registration_mode` is shape-checked at DB level (snake_case identifier). Mode-key _validity_ (key exists in the network's config) is an app-layer concern; an unknown mode at read time falls back to `form`.

Why drop and re-add instead of rename:

- No production rows to migrate (`submission_mode` is unreleased on the same branch).
- The check constraint shape changes (open identifier vs. closed enum), so a rename + alter constraint is the same work.

## 5. Runtime resolution

The route handlers resolve `registration_mode` → `submission_shape` via the live network config at every request. No persistence of the resolved shape — config is authoritative.

```ts
function resolveSubmissionShape(
  mode: string,
  cfg: NetworkConfig,
): 'account_only' | 'account_and_profile' {
  return cfg.aggregator.registration_modes[mode]?.submission_shape ?? 'account_and_profile';
}
```

A link with a `registration_mode` whose key is no longer declared in config gets the default `account_and_profile` shape — graceful degradation; never blows up.

## 6. Admin endpoints

### 6.1 `POST /v1/links/create`

Body accepts optional `registration_mode`. Default = first declared key in the network config (typically `form`).

Validation:

- Mode key must be declared in the live network config's `registration_modes` block. Unknown → `400 INVALID_REGISTRATION_MODE` with `detail: "registration_mode '<x>' is not declared for this network"` and `fields: { declared: [...keys] }`.
- `completion_actions[]` forbidden for modes whose `submission_shape === 'account_only'` (carried over from prior design — the dispatcher never fires for account-only).

### 6.2 `PATCH /v1/links/:id`

`UpdateLinkBodySchema.strict()` rejects any `registration_mode` key → `400 SCHEMA_VALIDATION` with the same shape as today's `submission_mode` rejection. Error code `REGISTRATION_MODE_IMMUTABLE` available for explicit throws if a future hand-rolled path bypasses Zod.

## 7. Public resolve

`GET /public/v1/aggregators/:org/links/:slug` returns:

```jsonc
{
  "slug": "...",
  "network": "purple_dot",
  "domain": "seeker",
  "context": { ... },
  "registration_mode": "voice",
  "submission_shape": "account_only",
  "public_hint_i18n_key": "registration_mode.voice.hint",
  "schema_id": null,
  "schema_version": null,
  "schema": null,
  "identity": { name, phone, email },
  "expires_at": null
}
```

When `submission_shape === 'account_only'`, `schema_*` are null. When `submission_shape === 'account_and_profile'`, the schema body is returned (current behaviour).

Server resolves shape + hint key on the read so the web client doesn't need to read config.

## 8. Public submit

`POST /public/v1/aggregators/:org/registrations/:slug`. Behaviour gates on the resolved `submission_shape`:

### 8.1 `account_only` shape (voice mode today)

Identical to today's account_only path:

- Allowed-key whitelist derived from network identity selectors (name, phone, email) + consent flags.
- Reject body with `item_state` or unknown keys → `400 REGISTRATION_MODE_MISMATCH` (renamed from `SUBMISSION_MODE_MISMATCH`).
- Identity-presence guard: name + (phone OR email) required → `400 SCHEMA_VALIDATION` if missing.
- Force `submit_mode: 'account_only'` to signals; no item_state.
- Dispatcher fan-out skipped.

### 8.2 `account_and_profile` shape (form mode today)

Silently accepts partial:

- No body-shape guard; accept all keys defined in the network schema's properties.
- Run Ajv but **drop `required`-keyword errors** before throwing. Type / format / pattern / enum / additionalProperties still 400.
- Empty cells stripped before Ajv (any value where trim() === '' or [] or null gets deleted — applies to required AND optional keys).
- Signals receives `submit_mode: 'with_item'` with whatever non-empty cells survived. Signals' classifier marks the resulting item `draft` if required fields are missing, `live` if all present.
- Drop the `partial` body flag entirely from the API contract. No-op on the server; web stops sending it.

## 9. Web

### 9.1 Admin "Share a registration link" form (`RegistrationLinksSection.tsx`)

- Dropdown renamed "Registration mode". Options sourced from `cfg.aggregator.registration_modes` (the new aggregator-config block is exposed via the existing `useAggregatorConfig` hook).
- Each option's display label uses `label_i18n_key` (resolved via next-intl).
- Hint line below the dropdown shows the selected option's `public_hint_i18n_key` translated (in the admin's locale), or a neutral placeholder if null.
- Body to `POST /api/links` carries `registration_mode: <selectedKey>` (was `submission_mode`).

### 9.2 Public form (`PublicRegistrationView.tsx`)

- Branch on `submission_shape` (resolved server-side, comes in the resolve response).
- `account_only` → render `MinimalIdentityForm` (existing component, already brand-themed). Below it, render the hint via `useTranslations` against `public_hint_i18n_key`. Hint is a small italic line under the submit button.
- `account_and_profile` → render the existing RJSF form. **Remove** the `Submit identity now, complete profile later` checkbox. Submit POSTs the full body verbatim; server silently accepts partial.

### 9.3 Removed surfaces

- `partial` state + checkbox + `bypassProbe` flag — the silent-partial server contract removes the need.
- `submission_mode` prop on `PublicRegistrationView`. Replaced by `submissionShape: 'account_only' | 'account_and_profile'` + `publicHintI18nKey: string | null`.

## 10. Endpoint changes summary

| Endpoint                                               | Change                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `POST /v1/links/create`                                | accepts `registration_mode` (default = config's first key); validates against live network config      |
| `PATCH /v1/links/:id`                                  | rejects `registration_mode` (immutable)                                                                |
| `GET /public/v1/aggregators/:org/links/:slug`          | returns `registration_mode` + resolved `submission_shape` + `public_hint_i18n_key`                     |
| `POST /public/v1/aggregators/:org/registrations/:slug` | gates on `submission_shape`; form branch silently accepts partial; voice branch enforces identity-only |

## 11. Error codes

| Code                          | HTTP | When                                                                                                                |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `INVALID_REGISTRATION_MODE`   | 400  | create body's mode key not in the network config                                                                    |
| `REGISTRATION_MODE_IMMUTABLE` | 400  | PATCH includes `registration_mode` (defence-in-depth — Zod `.strict()` already 400s)                                |
| `REGISTRATION_MODE_MISMATCH`  | 400  | account_only-shape link receives a body with `item_state` or unknown keys (renamed from `SUBMISSION_MODE_MISMATCH`) |

The three old `SUBMISSION_MODE_*` codes are removed.

## 12. i18n keys

Per locale (en/hi/kn):

- `registration_mode.field_label` — "Registration mode"
- `registration_mode.voice.label` — "Voice campaign"
- `registration_mode.voice.hint` — "Our team will call you on this number to complete your profile."
- `registration_mode.form.label` — "Form"
- `registration_mode.form.hint` (admin-only context, optional) — "Participants fill the full profile online. Partial submissions are accepted."

## 13. Tests

**Unit:**

- Config Zod parser: rejects bad `submission_shape`, requires `label_i18n_key`, accepts arbitrary number of modes, rejects bad mode keys (non-snake_case).
- `resolveSubmissionShape`: unknown mode → `'account_and_profile'`.

**Integration (API):**

- Admin create with `registration_mode='voice'` → persisted, response includes the field.
- Admin create with unknown mode → `400 INVALID_REGISTRATION_MODE`.
- Admin create with mode where `submission_shape='account_only'` AND `completion_actions[]` → `400 INVALID_CONFIG`.
- PATCH with `registration_mode` → 400 SCHEMA_VALIDATION.
- Public resolve: voice link → `submission_shape: 'account_only'`, schema null, hint key set. Form link → shape `account_and_profile`, schema body, hint key null.
- Public submit (voice): identity-only body → 201; body with `item_state` → 400 REGISTRATION_MODE_MISMATCH.
- Public submit (form): full body → 201; body with empty required cells → 201 (silently accepted); body with type-mismatched cell → 400 SCHEMA_VALIDATION.

**Web:**

- Admin form: dropdown options match the configured modes.
- Public view: branches on shape; account_only renders MinimalIdentityForm + hint; account_and_profile renders RJSF with NO partial checkbox.

**Schema test:**

- `aggregator.config.yaml` for purple_dot parses cleanly via the new Zod schema.

## 14. Migration & rollout

- One additive migration file: drops `submission_mode`, adds `registration_mode` (with default `form`). Tracked in `apps/api/drizzle/migrations/` so future devs / CI reproduce the schema. **No data migration / backfill** — `submission_mode` only exists on this draft branch and the local DB; the column drop is purely a schema cleanup, not a production rollback.
- Aggregator config: add the `registration_modes:` block to `config/purple_dot/aggregator.config.yaml` (the active network). Other networks (`blue_dot`, `orange_dot`) — add the same block as a follow-up.
- The submission_mode commits on the branch are _replaced_ by the registration_mode commits; the PR history will show the evolution but the final state has only `registration_mode`.

## 15. Open questions

None at design time. All decisions locked via brainstorming session 2026-06-09:

1. **Voice mode behaviour:** form only; voice call is out-of-band; no auto-dispatcher.
2. **Config scope:** per-network, inline in `config/<network>/aggregator.config.yaml`.
3. **Form mode partial UX:** drop the checkbox; silently accept partial.
4. **Migration:** drop the old column; default new column to `form`.

## 16. Out of scope (deferred)

- Auto-wiring `completion_actions[]` when voice mode is chosen.
- Real outbound vendor adapters.
- Additional channels (sms, whatsapp, kiosk) — config schema accepts them; this PR ships only voice + form.
- Per-mode admin permissions (e.g. "only this user role can create voice links").

## 17. Estimated work

- Config Zod schema + parser + test: 0.5d
- DB migration + Drizzle column rename: 0.25d
- Admin create/update validators + tests: 0.5d
- Public resolve + submit handlers + tests: 0.75d
- Web admin form + i18n: 0.5d
- Web public view + remove partial checkbox + i18n + tests: 0.75d
- Cleanup: remove old SUBMISSION*MODE*\* codes + tests + types: 0.25d
- Spec + plan docs + sweep: 0.5d

**Total: ~4 person-days.**
