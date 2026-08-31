# CLAUDE.md — apps/web

Guidance specific to working inside `apps/web`. Read the root `CLAUDE.md` first — this file covers what's non-obvious once you're actually editing files here.

## Two auth helpers, disjoint usage today — nothing in code stops you picking the wrong one

- **Anonymous**: `getServiceAccessToken()` (`lib/service-token.ts`) does a Keycloak `client_credentials` grant, cached in-process until ~30s before expiry. It's wrapped by `proxyServiceRequest()` (`lib/bff-service-proxy.ts`) and used by exactly 3 routes today: `api/aggregator/register`, `api/org/register`, `api/orgs` — genuinely pre-session (registration/listing) endpoints.
- **Authenticated**: `callApi()` (`lib/upstream-client.ts`) reads the Redis session, transparently refreshes the access token 60s before expiry (killing the session on refresh failure), and attaches the caller's own Bearer token. Used by all other API routes plus the protected layout.

**This split is convention-enforced only.** A new authenticated data route wired to `proxyServiceRequest`/`getServiceAccessToken` instead of `callApi` would authorize with the aggregator-wide service-account token rather than the caller's own — the concrete cross-aggregator data-leak shape to watch for. When adding a route: if it needs to know _which_ aggregator/coordinator is calling, it must use `callApi`; only genuinely pre-session registration/lookup endpoints should use the service-token path.

## Session shape and where `auth-context` actually comes from

`SessionStoreBase` (abstract class) has `RedisSessionStore` (prod) + `MemorySessionStore` (test), both taking a `ttlSec` — **`SESSION_TTL_SECONDS` env var, defaulting to 12h** (`lib/session/index.ts:24`), sliding (refreshed on every `get`). `SessionData` holds `sub/email/phone/name` + `accessToken/refreshToken/idToken` + their expiries + `createdAt/lastSeenAt`. `server-session.ts` wraps `getSession()` in React's `cache()` so one Redis hit is shared per request tree.

**`auth-context` is populated server-side, not by a client fetch.** `(protected)/layout.tsx` calls `getSession()` + `tokenAggregatorId()` (rejects org-owner tokens — this portal is coordinator-only) + `fetchSupportEnabled()` (`GET /v1/support/config` via `callApi`, fails safe to `false`), then passes both as props into `<AuthProvider initialUser supportEnabled>`. If you're debugging why the UI shows stale auth/support state, look at the layout's server render, not a client-side refetch — there isn't one.

## `aggregator-schema.server.ts` is the single source for both editable and read-only rendering

Both `/register` and `/profile` call `loadRegistrationSchema()`, which loads `registration.v1.json` + `.ui.json` from `config/schemas/aggregator/` (three-candidate path resolution for dev vs Docker cwd) and patches the `type` enum from `GET /v1/aggregator-config` (falls back silently on error). **The same schema/uiSchema objects** feed both modes:

- **Editable** (`/register`) — rendered as-is.
- **Read-only** (`/profile`, `ProfileFormView.tsx`) — achieved via RJSF's `readonly` prop (not per-field `ui:disabled`), plus a locally-built `readonlyUiSchema` that hides the `consent` block and empties the submit button's children.

`x-updatable` is a custom JSON Schema keyword read directly off `schema.properties[key]['x-updatable'] === true` (`collectUpdatableFields`, `ProfileFormView.tsx:76-79`) to build the "Request an update" panel — **purely config-driven**, no code change needed to add/remove which fields show as updatable. Note the panel is currently UI-only local state (`requestSent` just flips a banner) — there's no backend call behind "Request an update" yet; don't assume one exists when tracing a bug report about it.

## The public registration flow is more than the form — four config-gated surfaces wrap it

`(public)/register` (self-serve) and `[org]/[slug]` (`PublicRegistrationView`, per-link) surround the RJSF form with surfaces that only appear when config enables them; don't assume the form is the whole flow:

- **Pre-form "Already Registered — Sign In" chooser** (#652) — on first open, whenever the Signals hand-off is configured for this domain/mode, the participant chooses **Register** or is sent to the Signals UI to sign in (`SignalsSignInCta`). Config-gated by the same `signals_cta` rule as the hand-off.
- **Post-submit hand-off to the Signals UI** (#654) — on a successful full-profile submission the view redirects to the per-domain Signals login URL from the api's `SIGNALS_UI_URLS` map (parsed + URL-validated at api boot, frozen, surfaced via `/v1/aggregator-config`); no in-app "registration complete" dead-end.
- **On-demand registration QR** (#650) — a link's QR is **derived client-side** in the browser from the public URL (`components/ui/QrCode.tsx`), with no S3 round-trip; the server no longer persists a `qr_object_key`, and legacy rows that still have one return `qr_url: null`.
- **Scroll-gated consent** (#636) — the consent modal only enables acceptance once the participant has scrolled each document to the end (`components/consent/read-progress.ts`), with a small fractional-pixel slack so momentum/overscroll still trips the gate.

## Consent content has no API round-trip

`(public)/register/page.tsx` loads consent **server-side** via `@aggregator-dpg/config-loader/fs`'s `loadConsentConfig(network, brand)`, extracts each audience's `current_version` doc, and passes typed `ConsentDocContent` as props through `RegisterView` → forms → `ConsentModal`/`MarkdownContent`. Failure degrades to `null` (forms fall back to plain-text labels) rather than throwing — this resolves once per server render, no client-side caching/loading state to reason about.

## This app mostly doesn't follow the packages' abstract-class pattern

`src/services/*` (`profile.service.ts`, `dashboard.service.ts`, etc.) are plain client-side fetch modules, **not** `interface.ts`/abstract-class services — route handlers are the real "service boundary" here. The two places that _do_ follow the repo-wide base-class pattern (`.claude/rules/base-class-pattern.md`) are `lib/oidc/interface.ts` and `lib/session/interface.ts` — treat those two as governed by that rule; everything else under `src/services/` and `src/lib/*-client` files is not.

## Tests

Vitest + jsdom + `@testing-library/react` for components (`src/__tests__/components/*.test.tsx`, one co-located `components/support/__tests__`); plain unit tests for `src/services/__tests__/*.test.ts` (no fake-subpath convention — these are simple fetch wrappers, not abstract-class services). No Playwright/e2e. Coverage thresholds (70/70/60/70) are set in `vitest.config.ts`.

## Next.js specifics

`middleware.ts` is intentionally minimal (Edge runtime can't import `ioredis`) — it only stamps `x-pathname`; all real auth gating happens in `(protected)/layout.tsx` (Node runtime), not middleware. `NEXT_PUBLIC_*` vars (API URL, enabled languages) are **build-time only** — no runtime-config/`window.__CONFIG__` pattern exists here, so a VM redeploy after changing one **must** rebuild the image (`docker compose up -d --build`), not just restart the container.
