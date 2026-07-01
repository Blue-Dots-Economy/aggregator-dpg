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

**Location:** `config/<network>/consent.json` (co-located with the per-network schema dir the schema-loader already uses, e.g. `config/<network>/schemas/`), with an optional per-brand override merged over the network default (deferred if brand config isn't needed yet — see Open Question 1).

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

**`aggregator_consent_record`** (Drizzle, `packages/db-schema/src/schema.ts`):

| column             | type                               | notes                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------ |
| `id`               | uuid PK default random             |                                                  |
| `aggregator_id`    | uuid NOT NULL                      | the operator/aggregator (`aggregators.id`)       |
| `consent_category` | text NOT NULL                      | `terms` \| `privacy`                             |
| `document_version` | integer NOT NULL                   | the version accepted (= `current_version` shown) |
| `network`          | text NOT NULL                      | the network the aggregator registered under      |
| `brand`            | text NULL                          | brand variant if applicable                      |
| `source`           | text NOT NULL                      | `registration` (only source in v1)               |
| `accepted_at`      | timestamptz NOT NULL               | consent event time (server-stamped)              |
| `created_at`       | timestamptz NOT NULL default now() |                                                  |

- **Append-only** — one row per (aggregator, document) accepted at registration; `terms` + `privacy` → **two rows** per registration.
- No FK enforced beyond app-level (follow the repo's existing FK conventions for `aggregators`).
- Index on `(aggregator_id, consent_category)`.
- The existing `aggregators.consent` JSONB continues to be written by `stampConsent` (unchanged) — the new table adds the versioned, per-document ledger.

## 6. Backend changes

- **Shared schema** (`packages/shared-primitives/src/aggregator/index.ts`): extend the registration consent payload to carry the versions the client displayed:
  - `RegistrationConsentSchema` gains `terms_version: z.number().int().min(1)` and `privacy_version: z.number().int().min(1)` (in addition to `value: literal(true)`, `given_at`, `valid_till`).
- **Consent config Zod schema** (new, e.g. `packages/shared-primitives` or a config package): `AggregatorConsentConfigSchema` validating the §4 shape (per-document `current_version` ∈ `versions`, unique version ints), + `parseAggregatorConsentConfig`.
- **Register route** (`apps/api/src/routes/aggregator-registrations.ts`): after `createAggregatorWithSlug(...)` returns the `aggregator` (has `id`), and only when `body.consent.value === true` (already enforced), insert two `aggregator_consent_record` rows (`terms` @ `body.consent.terms_version`, `privacy` @ `body.consent.privacy_version`), with `network`/`brand` from the request context, `source: 'registration'`, `accepted_at` = the server-stamped time. Wrap the insert in try/catch **log-and-continue** (never fail the registration if only the ledger write fails; the JSONB snapshot still records acceptance). Keep `stampConsent` → `aggregators.consent` unchanged.
- **Version validation (light):** the server may validate the submitted versions equal the current `current_version` of the loaded consent config (reject stale/forged); or accept as-supplied for v1 (see Open Question 2).

## 7. Web changes

- **`register/page.tsx`** (server): read the resolved `consent.json` for the active network/brand and pass a `consentContent` prop (merged config: per-doc current version's `title`+`content`, and the `current_version` numbers) to `RegisterView`.
- **Custom consent field/widget** for the RJSF `consent.value` field: render the label as **"I have read and accept the [Terms of Service] and [Privacy Policy]"** where the two are buttons that open a **view-only popup**. Keep the checkbox (required, `value` must be true). Options:
  - a custom RJSF **widget** registered for the consent field via the UI schema (`registration.v1.ui.json` → `consent.value.ui:widget`), or a custom **field template** — whichever fits the repo's RJSF setup. It renders the checkbox + linked label + the popup.
- **Consent viewer popup** (new component, e.g. `apps/web/.../consent/ConsentModal`): a **read-only** dialog with two tabs (Privacy Policy / Terms of Service), each rendering the doc's current-version `title` + Markdown `content`. Sanitized Markdown (no raw HTML). Dismissible (it's read-only, not a gate). **No auto-open** — opened only by the link clicks.
- **Submit payload:** `RegisterView.handleSubmit` adds `terms_version` + `privacy_version` (from `consentContent`) into the `consent` object it POSTs, alongside the existing `value`/`given_at`/`valid_till`.
- **i18n:** the link labels + popup chrome (title/tab labels) use the aggregator's existing i18n mechanism; the document **content stays in English** (from config), matching the Signals decision.

## 8. Migration & compatibility

- Additive: new `aggregator_consent_record` table via `db:generate` + `db:migrate`; **no existing table altered**. `aggregators.consent` JSONB is untouched.
- No backfill — existing aggregators simply have no ledger rows (acceptable; their JSONB snapshot remains). New registrations write the ledger.
- The registration payload gains two optional-at-rest fields (`terms_version`, `privacy_version`); older clients that don't send them still work if the server defaults to the loaded `current_version` (see Open Question 2).

## 9. Testing

- **DB/API:** register with consent (value true + versions) → aggregator created + **two `aggregator_consent_record` rows** (terms, privacy) with correct versions + `source: registration`; JSONB snapshot still written; consent-ledger write failure does not fail registration.
- **Config:** `AggregatorConsentConfigSchema` validation (current_version ∈ versions; unique versions); per-network resolution (+ brand override if included).
- **Web:** the consent field renders clickable Terms/Privacy links; clicking opens the read-only popup on the right tab with Markdown content; checkbox still required to enable Submit; submit includes the versions.

## 10. Open questions (for reviewer)

1. **Per-brand override:** Signals supports per-network **and** per-brand consent overrides. Does the aggregator need per-brand consent content now, or is **per-network** sufficient for v1 (brand override deferred, config shape still allows it later)?
2. **Server-side version validation:** should the register route **validate** that `terms_version`/`privacy_version` equal the currently-active `current_version` (reject stale/forged submissions), or **trust** the client-supplied versions for v1 (lighter; matches Signals' client-supplied-version stance)?
3. **Content authoring:** confirm the aggregator Terms/Privacy wording should be authored fresh (operator-focused: aggregator onboarding, data handling of the operator org) — distinct from the Signals participant-facing content.
