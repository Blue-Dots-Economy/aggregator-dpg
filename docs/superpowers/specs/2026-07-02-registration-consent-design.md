# Aggregator Registration Consent — Design

**Date:** 2026-07-02
**Status:** Design — pending user review before the implementation plan
**Branch:** `feat/registration-consent` (rebased onto `feat/aggregator-org-coordinator`)
**Related:** mirrors the Signals-DPG consent work (`Signals-DPG` branch `feat/consent-management-v1`), scoped down to aggregator registration; reconciled with the org-coordinator restructure.

---

## 1. Goal

Upgrade the aggregator **registration** consent from a static, unversioned checkbox into a proper, **versioned, readable, recorded** consent — while staying deliberately minimal:

- On the registration forms, keep the existing required checkbox but make **"terms"** and **"privacy policy"** in its label **clickable links** that open a **view-only popup** (two tabs: Privacy Policy / Terms of Service, Markdown). **No auto-popup** — the popup opens only on link click; the checkbox is the acceptance.
- Author real, **versioned** operator-facing Terms + Privacy content (per network, with per-brand override), mirroring Signals' `consent.json`.
- Record the accepted **document versions + timestamp** in a new **append-only consent table** (system of record), keyed to the registering **subject** — an **org** or a **coordinator/aggregator** — alongside the existing `aggregators.consent` JSONB snapshot.

Versions are stored now so the system is **version-ready for the future**, but no version-based re-prompting or login-time consent is built in this iteration.

## 2. Scope

**In scope — BOTH registration forms** (post org-coordinator restructure):

- **Org registration** — `config/schemas/aggregator/org-registration.v1.json` → `apps/web/.../register/OrgRegisterForm.tsx` → `POST /api/org/register` → `aggregator-orgs.ts` (subject: `aggregator_orgs.id`).
- **Coordinator/aggregator registration** — `config/schemas/aggregator/registration.v1.json` → `RegisterView.tsx` (coordinator content) → `POST /api/aggregator/register` → `aggregator-registrations.ts` (subject: `aggregators.id`).
- For both: clickable T&P links + view popup, versioned consent config, and ledger recording.

**Out of scope (non-goals)**

- **No consent at signin/login.** Operator login is Keycloak SSO (redirect); no consent step there.
- **No re-consent / version-change prompting.** Versions recorded, not enforced.
- **No per-action / per-profile consent.**
- **No participant public-registration / bulk changes** — those participants consent in Signals.

## 3. Current state (verified, on the rebased branch)

- **Two registration flows**, gated by `ORG_HIERARCHY_ENABLED`, rendered by `apps/web/src/app/(public)/register/RegisterView.tsx` (tab switch, ~lines 412–444): an **Org** tab (`OrgRegisterForm`) and the **Coordinator** content (classic aggregator form, now with a parent-org selector).
- **Both forms carry the same consent field** `{ value: boolean, given_at, valid_till }`:
  - `config/schemas/aggregator/registration.v1.json` (consent block) + `.ui.json` (`consent.value` → checkbox widget; `given_at`/`valid_till` hidden).
  - `config/schemas/aggregator/org-registration.v1.json` (identical consent block) + `.ui.json`.
  - The label is **static text with no links**; `value` must be `true` to submit.
- **Shared client logic** in `apps/web/src/app/(public)/register/registration-shared.ts` (`stampConsent(existing)` sets `given_at`/`valid_till` client-side; both forms call it). A natural home for a shared consent-links widget/helper.
- **Recording today:**
  - **Coordinator/aggregator** (`apps/api/src/routes/aggregator-registrations.ts`): server-stamps consent (`stampConsent`, ~line 151, max 1-year validity) and stores it as a **JSONB snapshot on `aggregators.consent`**. No version, no table.
  - **Org** (`apps/api/src/routes/aggregator-orgs.ts`): the request body includes `consent`, but the create path (`orgStore.create({...})`) **does not pass consent** — it is parsed then **discarded**. `aggregator_orgs` has **no consent column**. → a real gap this work fixes.
- **DB** (Drizzle, `packages/db-schema/src/schema.ts`): `aggregators` (has `consent` JSONB + new `parentOrgId` → `aggregator_orgs.id`) and the new **`aggregator_orgs`** table (`id`, `slug`, `displayName`, `ownerEmail`, `ownerPhone`, `ownerKcSub`, `kcGroupId`, `status`, timestamps) — **no consent column**. Migrations via `pnpm --filter @aggregator-dpg/api db:generate` + `db:migrate`.
- **No Terms/Privacy document content exists** today (only the static checkbox label).
- **Register page schema loading** (`register/page.tsx`): reads `registration.v1.json`/`.ui.json` and (optionally) `org-registration.v1.json`/`.ui.json` from `config/schemas/aggregator/` via `readFile` + `resolveSchemaPath`, passes to `RegisterView`. Same pattern will serve the consent content.
- **API:** Fastify + Zod; repo rules apply (abstract-class service contracts, `Result<T,BaseError>` across boundaries, structured logging via `@aggregator-dpg/observability`, config via `config-loader`, tests with in-memory fakes ≥70%).

## 4. Content — versioned, per-audience consent config (mirror Signals)

Per-network consent config with **version history**, matching Signals' `consent.json`, but with a **per-audience dimension** — org and coordinator/aggregator consent content may differ, so each audience has its own Terms + Privacy documents (independently versioned).

**Location:** `config/<network>/consent.json` (co-located with the per-network schema dir, e.g. `config/<network>/schemas/`) with a **per-brand override** merged over the network default. Resolution mirrors `resolveSchemaPath`.

```jsonc
{
  "audiences": {
    "org": {
      "documents": {
        "terms": {
          "current_version": 1,
          "versions": [
            {
              "version": 1,
              "title": "Terms of Service",
              "content": "<org markdown>",
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
              "content": "<org markdown>",
              "effective_from": "2026-07-01",
            },
          ],
        },
      },
    },
    "aggregator": {
      "documents": {
        "terms": {
          "current_version": 1,
          "versions": [
            {
              "version": 1,
              "title": "Terms of Service",
              "content": "<coordinator markdown>",
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
              "content": "<coordinator markdown>",
              "effective_from": "2026-07-01",
            },
          ],
        },
      },
    },
  },
}
```

- **Two audiences** keyed to the ledger `subject_type` (§5): `org` (org-registration form) and `aggregator` (coordinator/aggregator form, a.k.a. "coordinator"). Each has its own `terms` + `privacy`, so content **and versions differ per audience**.
- Append-only `versions[]` per document; `current_version` selects what the popup renders + what version is recorded. Same rules as Signals §4.1.
- Only `terms` + `privacy` per audience. Validated by a Zod schema (§6).
- **Content is authored fresh, operator/org-facing.** Org content addresses the **organization** registering (org-level data, ownership, responsibilities for its coordinators); coordinator/aggregator content addresses the **coordinator/aggregator** onboarding under an org. Distinct from Signals' participant-facing content.
- **Serving:** `register/page.tsx` reads the resolved `consent.json` and passes each audience's merged content (current version's `title`+`content` per doc) to `RegisterView` — the **org** content to `OrgRegisterForm`, the **aggregator** content to the coordinator form. No new API endpoint.

## 5. Data model — new consent table (append-only, subject-polymorphic)

One table, the **system of record** for aggregator-side registration consent, keyed by a **subject** so it serves both the org and the coordinator/aggregator flows. One row per registration acceptance (single checkbox → one row; both document versions in their own columns).

**`aggregator_consent_record`** (Drizzle, `packages/db-schema/src/schema.ts`):

| column            | type                               | notes                                                        |
| ----------------- | ---------------------------------- | ------------------------------------------------------------ |
| `id`              | uuid PK default random             |                                                              |
| `subject_type`    | text NOT NULL                      | `org` \| `aggregator` — which flow captured it               |
| `subject_id`      | uuid NOT NULL                      | `aggregator_orgs.id` (org) or `aggregators.id` (coordinator) |
| `terms_version`   | integer NOT NULL                   | Terms version accepted (= config `current_version`)          |
| `privacy_version` | integer NOT NULL                   | Privacy version accepted                                     |
| `network`         | text NOT NULL                      | network the registration is under                            |
| `brand`           | text NULL                          | brand variant if applicable                                  |
| `source`          | text NOT NULL                      | `registration` (only source in v1)                           |
| `accepted_at`     | timestamptz NOT NULL               | server-stamped consent time                                  |
| `created_at`      | timestamptz NOT NULL default now() |                                                              |

- **Append-only** — one row per registration acceptance (both versions in the row; both `1` in v1).
- No cross-table FK on `subject_id` (polymorphic; app-level integrity — the route already created/owns the subject row). Index on `(subject_type, subject_id)`.
- `aggregators.consent` JSONB stays (coordinator flow, back-compat). The org flow gets its consent **recorded here** (fixing today's discard) — no consent column added to `aggregator_orgs`.

## 6. Backend changes

- **No client-sent versions, no version validation (v1).** The registration payloads keep `consent: { value, given_at, valid_till }` (unchanged). At registration the **server** loads the resolved consent config for the network/brand and records the **current** version of each document **from the matching audience** — the org route uses `audiences.org`, the coordinator/aggregator route uses `audiences.aggregator` (both `1` in v1). Nothing to validate (only v1).
- **Consent config Zod schema** (new, in a config/shared package following repo interface rules): `AggregatorConsentConfigSchema` (per-document `current_version` ∈ `versions`, unique version ints) + parser; typed via `z.infer`.
- **Consent-ledger writer** (new service, repo pattern: abstract base + postgres + memory + testing): `recordRegistrationConsent({ subjectType, subjectId, network, brand, termsVersion, privacyVersion })` inserting one `aggregator_consent_record` row; returns `Result<…, BaseError>`; structured logging.
- **Coordinator/aggregator route** (`aggregator-registrations.ts`): after the aggregator row is created (`aggregators.id`), record consent (subject_type `aggregator`, versions from the loaded config). Keep `stampConsent` → `aggregators.consent` JSONB unchanged.
- **Org route** (`aggregator-orgs.ts`): after `orgStore.create(...)` returns the org (`aggregator_orgs.id`), record consent (subject_type `org`) — **fixing the current discard**. (Consent stays out of `aggregator_orgs` columns; it lives in the ledger.)
- Both: recording is **log-and-continue** (never fail registration on a ledger-write error); boundaries return `Result`/typed errors; no bare `console.log`.

## 7. Web changes

- **`register/page.tsx`** (server): read the resolved `consent.json` for the active network/brand and pass the **per-audience** content down to `RegisterView` — the `aggregator` audience's current-version `title`+`content` to the coordinator content, and the `org` audience's to `OrgRegisterForm`.
- **Shared consent field/widget** (in/near `registration-shared.ts`): render the consent label as **"I have read and accept the [Terms of Service] and [Privacy Policy]"** with the two as buttons opening the view popup; keep the required checkbox. Implement as a custom RJSF **widget** registered via each form's `.ui.json` (`consent.value.ui:widget`) or a shared field template — **used by both forms** (single implementation).
- **Consent viewer popup** (new shared component, e.g. `apps/web/.../consent/ConsentModal`): read-only dialog, two tabs (Privacy Policy / Terms of Service), current-version `title` + **sanitized Markdown** content (no raw HTML). Dismissible; **no auto-open**.
- **Submit payloads unchanged** — versions recorded server-side from config (§6).
- **i18n:** link labels + popup chrome use the aggregator's existing i18n (`apps/web/src/i18n/messages/{en,hi,kn}.json`); document **content stays English** (from config), matching Signals.

## 8. Migration & compatibility

- Additive: new `aggregator_consent_record` table via `db:generate` + `db:migrate`; **no existing table altered** (org route change is additive recording, not a schema change to `aggregator_orgs`). Request/response shapes unchanged. `aggregators.consent` JSONB untouched.
- No backfill — existing orgs/aggregators have no ledger rows; new registrations write one row each.

## 9. Testing

- **DB/API:** org registration → org created + **one `aggregator_consent_record`** row (`subject_type: org`, versions from config, `source: registration`) — verifying the previously-discarded org consent is now recorded; coordinator/aggregator registration → one row (`subject_type: aggregator`) + JSONB snapshot still written; ledger-write failure does not fail registration.
- **Config:** `AggregatorConsentConfigSchema` validation; per-network + per-brand resolution/merge.
- **Web:** both forms render clickable Terms/Privacy links; clicking opens the read-only popup on the right tab with Markdown; checkbox still required to submit.
- Repo rules: unit tests use `./testing` in-memory fakes (no real DB/network); integration tests `*.integration.test.ts`; ≥70% coverage; the new ledger service ships `interface` + `postgres` + `memory` + `testing`.

## 10. Resolved decisions

1. **Scope → both forms.** Org registration + coordinator/aggregator registration both get the links-popup + versioned ledger recording. The ledger is subject-polymorphic (`subject_type` + `subject_id`). This also fixes the org route silently discarding consent.
2. **Per-brand override → yes** (per-network default + per-brand).
3. **No version validation in v1.** Client sends no versions; server records config `current_version` (=1). Table is version-ready (per-document version columns).
4. **Content → fresh operator/org-facing, per audience.** Separate Terms + Privacy content (and versions) for the `org` audience vs the `aggregator` (coordinator) audience — they may differ — within each network/brand's `consent.json` under `audiences.{org,aggregator}`. Authored in the plan.
