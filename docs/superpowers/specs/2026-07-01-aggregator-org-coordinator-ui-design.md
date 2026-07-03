# Aggregator Org + Coordinator — Web UI Design

**Date:** 2026-07-01
**Status:** Design — pending user review before the implementation plan
**Branch:** `feat/aggregator-org-coordinator`
**Depends on:** `2026-06-30-aggregator-org-coordinator-design-v2.md` (the API/DB spec — fully implemented on this branch).

**Goal:** Build the web-portal UI for the org→coordinator hierarchy. The backend (DB, stores, API routes, approval flows, token binding, rate limiting) is done per design-v2. This spec covers the **only remaining piece: the front end** — the two flag-gated registration surfaces (Org tab + Coordinator tab with an org selector). Org-owner console login stays **out of scope** (design-v2 §9 defers it).

---

## 1. What exists vs what this adds

**Backend (done, design-v2):**

- `POST /v1/orgs/create` — org registration submit (flag-gated).
- `GET /v1/orgs` — active-org list (flag-gated; plain SQL, `status='active'`).
- `POST /v1/aggregator-registrations/create` — coordinator submit, accepts optional `org_id`; enforces org-required + bootstrap guard when `ORG_HIERARCHY_ENABLED=true`.
- Error codes: `ORG_SLUG_TAKEN`, `OWNER_ALREADY_REGISTERED`, `TARGET_ORG_INACTIVE`, `RATE_LIMITED`, plus the existing `USER_EXISTS` / `PHONE_EXISTS`.

**Web (this spec):** nothing hierarchy-related exists today — `RegisterView` is a single flat coordinator form. We add the flag-gated tabs, the org form, the coordinator org selector, two BFF proxies, config schema files, and i18n.

---

## 2. Feature flag delivery (web)

The flag is the **same env var the API reads** — `ORG_HIERARCHY_ENABLED`. The web app reads it **server-side**, matching how the portal already reads env (`API_BASE_URL`, `AGGREGATOR_NETWORK`, `CONFIG_ROOT`) — **not** via the `/v1/aggregator-config` HTTP endpoint.

- Read in the `/register` **server component** (`page.tsx`, already `export const dynamic = 'force-dynamic'`) via `process.env.ORG_HIERARCHY_ENABLED`.
- Parse to boolean (`=== 'true'`, trimmed), pass as a prop `orgHierarchyEnabled` into `RegisterView`.
- No `/v1/aggregator-config` change. No `useAggregatorConfig` change.
- Document the var in `infra/env.template` (web section) and `apps/web/.env.example`. Default **off** (absent/`false`) → today's UI verbatim.

Rationale: it's a per-instance deploy flag, exactly like the network switch. Server-side read keeps it out of the client bundle and avoids a build-time bake (`force-dynamic` means runtime `process.env` works).

---

## 3. `/register` page (server component)

`apps/web/src/app/(public)/register/page.tsx`:

1. Session redirect (unchanged).
2. Load coordinator RJSF schema + ui schema (unchanged), patch `type` enum from network (unchanged).
3. Read `orgHierarchyEnabled` from env.
4. **If flag on:** also load the org RJSF schema + ui schema (`org-registration.v1.json` / `.ui.json`) from the same `resolveSchemaRoot()` config dir. If the org schema files are missing, log a warning and fall back to flag-off behaviour (defensive — a flag-on network without the schema shouldn't 500 the register page).
5. Render `<RegisterView coordinatorSchema uiSchema orgSchema orgUiSchema orgHierarchyEnabled />`.

---

## 4. `RegisterView` (client)

`apps/web/src/app/(public)/register/RegisterView.tsx`.

- **Flag off** → render exactly today's coordinator form. **Zero visual change**, no tabs, no org calls.
- **Flag on** → tab switch above the form:
  - **Register Organisation** → `OrgRegisterForm`.
  - **Register as Coordinator** → today's form + a required Organisation selector at the top.
- Default active tab: **Coordinator** (the common case once orgs exist). Tab state is local (`useState`); no URL param needed for v1.

Keep `RegisterView` as the shell (brand panel, header, tab chrome, shared error/success rendering). Extract the two forms so neither file does too much:

- `OrgRegisterForm.tsx` — org RJSF form + submit + result states.
- The coordinator form stays inline in `RegisterView` (it's today's code) but gains the org selector; if `RegisterView` grows unwieldy, extract `CoordinatorRegisterForm.tsx` in the same pass.

### 4.1 Coordinator org selector

- A required `<select>` (reuse the shadcn Select already used by RJSF widgets for visual consistency) rendered **above** the RJSF form when the flag is on.
- Options from `GET /api/orgs` (BFF proxy → `GET /v1/orgs`), fetched client-side via the existing `jsonFetch` + react-query pattern. Each option: `{ id, display_name }`, value = `id`.
- Selected `org_id` is sent to the register BFF alongside the form body.
- **Bootstrap empty state:** zero active orgs → hide the RJSF form, disable submit, show copy: "No organisations are live yet. An organisation must be registered and approved before coordinators can join." (mirrors the API bootstrap guard so the user never hits a raw 400.)
- **Fetch error:** show a non-blocking inline error + a retry; do not render the form (can't submit without a valid org).
- Submit with no org selected → client-side validation error before calling the API (defence-in-depth; the API also rejects).

### 4.2 Org form (`OrgRegisterForm`)

- RJSF form from `org-registration.v1.json`. Fields: `display_name` (required), `slug` (required, auto-derived + editable), `state` (optional), `owner_email` (required, email format).
- **Slug behaviour:** a small controlled coupling — when the user edits `display_name` and hasn't manually touched `slug`, live-derive `slug` via a `slugify()` helper. Once the user edits `slug` directly, stop auto-syncing (track a `slugDirty` flag). Server still enforces uniqueness.
- Submit → `POST /api/org/register` (BFF) → `/v1/orgs/create`.
- Success state: "Organisation submitted. Our team will review it and email <owner_email> once it's approved." (Org approval routes to the **network admin**, not the applicant — copy reflects "under review".)

### 4.3 Error mapping (both forms)

Map machine-readable codes to friendly copy (i18n keys), reusing the existing envelope-parsing already in `RegisterView`:

| Code                           | Surface                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ORG_SLUG_TAKEN`               | org form, on `slug` field                                                                             |
| `OWNER_ALREADY_REGISTERED`     | coordinator form — "This email belongs to an organisation owner. Request coordinator access instead." |
| `TARGET_ORG_INACTIVE`          | coordinator form — org went inactive; prompt to reselect                                              |
| `RATE_LIMITED`                 | either — "Too many attempts. Please try again shortly."                                               |
| `USER_EXISTS` / `PHONE_EXISTS` | coordinator form (today's copy)                                                                       |

---

## 5. BFF proxies (new)

Both follow the existing `apps/web/src/app/api/aggregator/register/route.ts` pattern (service-account token via `getServiceAccessToken`, `API_BASE_URL`, error envelope passthrough, unreachable-API hint).

- `apps/web/src/app/api/org/register/route.ts` — `POST` → `${API_BASE_URL}/v1/orgs/create`. Forwards body, attaches service token, passes upstream status + envelope through verbatim.
- `apps/web/src/app/api/orgs/route.ts` — `GET` → `${API_BASE_URL}/v1/orgs`. Returns the active-org array. Cached `no-store`.

The existing coordinator BFF (`/api/aggregator/register`) is extended to forward `org_id` when present (it currently forwards the form body; add `org_id` passthrough).

---

## 6. New / changed files

**New:**

- `config/<network>/schemas/aggregator/org-registration.v1.json` + `org-registration.v1.ui.json` — added for each network that will run flag-on (at minimum the one used for local dev/testing; document the requirement in `config/README.md`).
- `apps/web/src/app/api/org/register/route.ts`
- `apps/web/src/app/api/orgs/route.ts`
- `apps/web/src/app/(public)/register/OrgRegisterForm.tsx`
- `apps/web/src/lib/slugify.ts`

**Changed:**

- `apps/web/src/app/(public)/register/page.tsx` — read flag, load org schema.
- `apps/web/src/app/(public)/register/RegisterView.tsx` — tabs, org selector, wire org form.
- `apps/web/src/app/api/aggregator/register/route.ts` — forward `org_id`.
- `apps/web/src/i18n/messages/{en,hi,kn}.json` — tab labels, org field labels, empty-state, error copy.
- `infra/env.template`, `apps/web/.env.example` — document `ORG_HIERARCHY_ENABLED` for web.

---

## 7. Testing

Vitest (web package), fakes over network per project rules.

- **slugify** — unit: spaces/case/punctuation/unicode/empty → deterministic output.
- **BFF `/api/orgs`** — proxies `GET /v1/orgs`, passes array through, forwards upstream error status/envelope, handles unreachable API.
- **BFF `/api/org/register`** — attaches service token, forwards body + upstream status, envelope passthrough.
- **`/api/aggregator/register`** — includes `org_id` when supplied; omits when absent (flag-off parity).
- **RegisterView (RTL)**:
  - flag off → single form, no tabs, no org fetch.
  - flag on → two tabs; coordinator tab shows org selector.
  - coordinator submit posts the selected `org_id`.
  - zero active orgs → submit disabled + empty-state copy.
  - error codes render mapped copy (`ORG_SLUG_TAKEN`, `OWNER_ALREADY_REGISTERED`).
- Coverage ≥ 70% lines (repo target).

---

## 8. Out of scope

- Org-owner console login / org dashboard (design-v2 §9 — deferred).
- Invite-based coordinator onboarding (design-v2 §12).
- Multi-org coordinator selector (single org now).
- Any API/DB change — backend is complete; this is web-only except the two env-template doc lines.
