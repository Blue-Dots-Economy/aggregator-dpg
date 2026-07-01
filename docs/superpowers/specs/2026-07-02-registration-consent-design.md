# Aggregator Registration Consent — Design

**Date:** 2026-07-02
**Status:** Design — pending user review before the implementation plan
**Branch:** `feat/registration-consent` (based on `feature`)
**Related:** mirrors the Signals-DPG consent work (`Signals-DPG` branch `feat/consent-management-v1`), scoped down to aggregator registration only.

---

## 1. Goal

Upgrade the aggregator operator **registration** consent from a static, unversioned checkbox into a proper, **versioned, readable, recorded** consent — while staying deliberately minimal:

- On the registration form, keep the existing required checkbox but make **"terms"** and **"privacy policy"** in its label **clickable links** that open a **view-only popup** (two tabs: Privacy Policy / Terms of Service, rendered from Markdown). **No auto-popup** — the popup opens only when a link is clicked; the checkbox remains the acceptance.
- Author real, **versioned** Terms + Privacy content (per network, with optional per-brand override), mirroring Signals' `consent.json`.
- Record the accepted **document versions + timestamp** in a new **append-only consent table** (system of record), keyed to the aggregator, alongside the existing `aggregators.consent` JSONB snapshot.

Versions are stored now so the system is **version-ready for the future**, but no version-based re-prompting or login-time consent is built in this iteration.

## 2. Scope

**In scope**

- Aggregator **operator registration** form (`config/schemas/aggregator/registration.v1.json`, rendered by `apps/web/.../register/RegisterView.tsx`): clickable T&P links + view popup.
- Versioned consent content config (Terms + Privacy) + a new consent table + recording at registration.

**Out of scope (explicit non-goals)**

- **No consent at signin/login.** Aggregator operator login is Keycloak SSO (redirect) — no consent step is added there. (Earlier idea of a pre-OTP/login gate is dropped; the aggregator has no local OTP step anyway.)
- **No re-consent / version-change prompting.** Versions are recorded, not enforced.
- **No per-action / per-profile consent** (aggregator has none of those flows).
- **No participant public-registration / bulk changes** — those participants consent in Signals; only the operator registration form is touched.

## 3. Current state (verified)

- **Login = Keycloak SSO redirect** (`apps/web/src/app/api/auth/login/route.ts` → `/api/auth/login` → Keycloak). No local email/phone+OTP form. → confirms no login-time gate.
- **Registration form** is RJSF-driven from `config/schemas/aggregator/registration.v1.json` + `registration.v1.ui.json`, loaded on the server in `apps/web/src/app/(public)/register/page.tsx` (`readFile(...)`, then passed to `RegisterView`). The consent field:
  ```jsonc
  "consent": {
    "type": "object", "title": "Terms & Privacy Consent",
    "required": ["value"],
    "properties": {
      "value": { "type": "boolean", "title": "I have read and accept the terms and privacy policy" },
      "given_at": { "type": "string", "format": "date-time" },
      "valid_till": { "type": "string", "format": "date-time" }
    }
  }
  ```
  The label is **static text with no links**. `value` must be `true` to submit (`RegistrationConsentSchema` uses `value: z.literal(true)`).
- **Recording today:** on submit, `RegisterView` POSTs to `/api/aggregator/register`; `apps/api/src/routes/aggregator-registrations.ts` server-stamps consent (`stampConsent`) and stores it as a **JSONB snapshot** on `aggregators.consent` (`{ value, given_at, valid_till }`) — **no separate table, no version**.
- **DB:** Drizzle (`packages/db-schema/src/schema.ts`); migrations via `pnpm --filter @aggregator-dpg/api db:generate` + `db:migrate`. `ConsentRecord` type lives in `packages/shared-primitives/src/aggregator/index.ts`.
- **No Terms/Privacy document content exists** anywhere today (only the static checkbox label).
- **Identity key:** the operator/aggregator is `aggregators.id` (uuid), created at registration (status `pending`), mirrored to Keycloak as the `aggregator_id` attribute.
- **API:** Fastify + Zod; **Web:** Next.js (App Router) + RJSF.

## 4. Content — versioned consent config (mirror Signals)

Add a per-network consent config (Terms + Privacy only) with **version history**, matching Signals' `consent.json` shape.

**Location:** `config/<network>/consent.json` (co-located with the per-network schema dir the schema-loader already uses, e.g. `config/<network>/schemas/`), **with a per-brand override** merged over the network default (a brand may ship brand-specific consent content — decision: per-brand supported). Resolution mirrors how the registration schema/brand is resolved for the register page.

```jsonc
{
  "documents": {
    "terms": {
      "current_version": 1,
      "versions": [
        {
          "version": 1,
          "title": "Terms of Service",
          "content": "<sanitized markdown>",
          "effective_from": "2026-07-01",
        },
      ],
    },
    "privacy": {
      "current_version": 1,
      "versions": [
        {
          "version": 1,
          "title": "Privacy Policy",
          "content": "<sanitized markdown>",
          "effective_from": "2026-07-01",
        },
      ],
    },
  },
}
```

- **Version history is retained** (append-only `versions[]` per document); `current_version` selects what the popup renders and what version is recorded. Same rules as Signals §4.1 (never edit past versions; append + bump `current_version`).
- Only `terms` + `privacy` (no `profile_creation` / `actions` — aggregator has none).
- Validated by a Zod schema (see §6). Content authored per network (e.g. `purple_dot`, `blue_dot`, `orange_dot`, `yellow_dot`) with aggregator-appropriate wording.

**Serving:** the register **server component** (`register/page.tsx`) reads the resolved `consent.json` (same `readFile` pattern as the registration schema, resolved for the active network/brand) and passes the merged config to `RegisterView` as a prop. No new API/BFF endpoint is required (mirrors how the registration schema is already provided). The popup renders `documents.<doc>.versions.find(v => v.version === current_version)` as Markdown.

## 5. Data model — new consent table (append-only)

A new table, the **system of record** for aggregator consent, alongside the existing `aggregators.consent` JSONB (kept for back-compat).

**Design decision — one row per acceptance (not one per document).** The operator ticks a single checkbox covering both Terms + Privacy — it's one acceptance event. So we record **one row per registration acceptance**, carrying **both** document versions in their own columns (rather than a `consent_category` + single `document_version`, which would force two rows for one click). This still keeps the ledger **version-ready per document**: if Terms later bumps to v2 while Privacy stays v1, a row can hold `terms_version: 2, privacy_version: 1`.

**`aggregator_consent_record`** (Drizzle, `packages/db-schema/src/schema.ts`):

| column            | type                               | notes                                                            |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `id`              | uuid PK default random             |                                                                  |
| `aggregator_id`   | uuid NOT NULL                      | the operator/aggregator (`aggregators.id`)                       |
| `terms_version`   | integer NOT NULL                   | Terms version accepted (= `documents.terms.current_version`)     |
| `privacy_version` | integer NOT NULL                   | Privacy version accepted (= `documents.privacy.current_version`) |
| `network`         | text NOT NULL                      | the network the aggregator registered under                      |
| `brand`           | text NULL                          | brand variant if applicable                                      |
| `source`          | text NOT NULL                      | `registration` (only source in v1)                               |
| `accepted_at`     | timestamptz NOT NULL               | consent event time (server-stamped)                              |
| `created_at`      | timestamptz NOT NULL default now() |                                                                  |

- **Append-only** — **one row per registration acceptance** (both versions in that row). In v1 both are `1`.
- No FK enforced beyond app-level (follow the repo's existing FK conventions for `aggregators`).
- Index on `(aggregator_id)`.
- The existing `aggregators.consent` JSONB continues to be written by `stampConsent` (unchanged) — the new table adds the versioned ledger.

## 6. Backend changes

- **No client-sent versions, no version validation (v1 decision).** The registration payload's `consent` stays `{ value, given_at, valid_till }` — unchanged. The client does **not** send versions. At registration the **server** loads the resolved consent config for the network/brand and records the **current** version of each document (both `1` in v1). Nothing to validate because there is only v1. (When real versioning arrives, the server keeps being the source of the recorded version.)
- **Consent config Zod schema** (new, in a config/shared package): `AggregatorConsentConfigSchema` validating the §4 shape (per-document `current_version` ∈ `versions`, unique version ints) + `parseAggregatorConsentConfig`. Follows the repo's interface conventions (`<Entity>Schema`, `z.infer` type).
- **Register route** (`apps/api/src/routes/aggregator-registrations.ts`): after `createAggregatorWithSlug(...)` returns the `aggregator` (has `id`), and since `body.consent.value === true` is already enforced, load the consent config for the request's network/brand, and insert **one** `aggregator_consent_record` row: `{ aggregator_id, terms_version: documents.terms.current_version, privacy_version: documents.privacy.current_version, network, brand, source: 'registration', accepted_at: <server-stamped time> }`. Wrap the insert in try/catch **log-and-continue** (never fail registration on a ledger-write error; the JSONB snapshot still records acceptance). Keep `stampConsent` → `aggregators.consent` unchanged. Follow repo rules: return `Result`/typed errors across service boundaries, structured logging via `@aggregator-dpg/observability`.

## 7. Web changes

- **`register/page.tsx`** (server): read the resolved `consent.json` for the active network/brand (same `readFile`/resolve pattern as the registration schema) and pass a `consentContent` prop (the current version's `title`+`content` for each doc) to `RegisterView`.
- **Custom consent field/widget** for the RJSF `consent.value` field: render the label as **"I have read and accept the [Terms of Service] and [Privacy Policy]"** where the two are buttons that open a **view-only popup**. Keep the checkbox (required, `value` must be true). Implement via a custom RJSF **widget** registered through the UI schema (`registration.v1.ui.json` → `consent.value.ui:widget`) or a custom field template — whichever fits the repo's RJSF setup.
- **Consent viewer popup** (new component, e.g. `apps/web/.../consent/ConsentModal`): a **read-only** dialog with two tabs (Privacy Policy / Terms of Service), each rendering the doc's current-version `title` + Markdown `content`. Sanitized Markdown (no raw HTML). Dismissible (it's read-only, not a gate). **No auto-open** — opened only by the link clicks.
- **Submit payload unchanged** — the client keeps sending `consent: { value, given_at, valid_till }`; versions are recorded server-side from the config (§6).
- **i18n:** the link labels + popup chrome (title/tab labels) use the aggregator's existing i18n mechanism; the document **content stays in English** (from config), matching the Signals decision.

## 8. Migration & compatibility

- Additive: new `aggregator_consent_record` table via `db:generate` + `db:migrate`; **no existing table altered**. `aggregators.consent` JSONB is untouched. Registration request/response shapes are unchanged.
- No backfill — existing aggregators simply have no ledger rows (acceptable; their JSONB snapshot remains). New registrations write one ledger row.

## 9. Testing

- **DB/API:** register with consent (`value: true`) → aggregator created + **one `aggregator_consent_record` row** with `terms_version`/`privacy_version` = the config's current versions + `source: registration`; JSONB snapshot still written; a ledger-write failure does not fail registration.
- **Config:** `AggregatorConsentConfigSchema` validation (current_version ∈ versions; unique versions); per-network + per-brand resolution/merge.
- **Web:** the consent field renders clickable Terms/Privacy links; clicking opens the read-only popup on the right tab with Markdown content; checkbox still required to enable Submit.
- Per repo rules: unit tests use in-memory fakes (no real DB/network); integration tests are `*.integration.test.ts`; ≥70% line coverage.

## 10. Resolved decisions (previously open)

1. **Per-brand override → yes.** Per-network default + per-brand override (a brand may ship brand-specific consent content). Config shape supports both.
2. **No version validation in v1.** There is only v1, so the client sends no versions and the server records the config's `current_version` (=1) for each document. Real versioning + validation is a later iteration; the table is already version-ready (per-document version columns).
3. **Content authoring — PENDING your answer:** author fresh, **operator/aggregator-facing** Terms + Privacy content (organization applying to become an aggregator; how the operator org's data is handled; aggregator responsibilities), OR reuse the Signals **participant-facing** content. (Recommendation: author fresh operator-facing content.)
