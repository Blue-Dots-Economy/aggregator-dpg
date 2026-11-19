# Two-option QR form (#1122) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `voice_or_form` registration mode whose public page offers "talk to the voice assistant" (name + phone → account only → `tel:` number) or the existing register / sign-in path, with voice bots configured per instance and picked per link.

**Architecture:** Config gains `voice_bots` + `default_voice_bots` and an optional `offers` on registration modes. Links store a nullable `voice_bot_key`; the number is resolved from config on every read. A new public endpoint handles the voice path (probe, then account-only onboard if new); the existing submit route is untouched. The web adds a coordinator bot picker and a first-screen chooser that wraps today's public view.

**Tech Stack:** pnpm + Turbo, Fastify + Zod + Drizzle (api), Next.js 15 App Router + next-intl (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-19-qr-two-options-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- Branch from `feature`. Stack per `.claude/rules/pull-requests.md`: `feat/1122-qr-two-options-api` (Tasks 1–5, incl. `packages/network-config`, migration, `openapi.json`, `policy/rbac/edge/routes.json`) → `feat/1122-qr-two-options-web` (Tasks 6–8) → `feat/1122-qr-two-options-config` (Task 9, and the spec + plan docs).
- `voice` and `form` links and the existing `POST …/registrations/:slug` route must behave byte-identically; their existing tests pass unchanged.
- Never log a phone number, name or `contact` value. Log ids, keys and outcomes only.
- No `as` casts, no `any`; TSDoc on every exported symbol; named constants for limits (`.claude/rules/*`).
- Commit messages: one Conventional Commits subject line, no AI trailers (repo `CLAUDE.md`). Never `--no-verify`.
- Do not push, open PRs or merge without the user's explicit yes (Task 10).
- New error codes: `INVALID_VOICE_BOT` (400), `VOICE_BOT_REQUIRED` (400), `VOICE_BOT_UNAVAILABLE` (409).
- Hindi and Kannada strings are flagged for a native-speaker check in the web PR description.

## Review Focus

1. **A bot whose `domains` no longer includes the link's domain** (config edited after the link was printed) — must fall back to that domain's default, never show a bot for the wrong participant type. Test in Task 4.
2. **Phone typed with spaces / `0` prefix / `+91`** on the voice path — normalised before the probe so an existing account is found. Test in Task 5.
3. **Bot removed between page load and voice submit** — POST answers 409 `VOICE_BOT_UNAVAILABLE`, page returns to the first screen without the voice button. Tests in Tasks 5 and 8.
4. **Old `voice` link resolve body** — only the two new keys (`offers: ['form']`, `voice_bot: null`) are added; everything else equal. Test in Task 4.
5. **Coordinator serving two domains switches domain in the create form** — the bot picker refetches for the new domain and clears a chosen key that does not serve it. Test in Task 7.

---

### Task 1: Voice-bot config schema and resolution helpers

**Files:**

- Modify: `packages/network-config/src/interface.ts` (`RegistrationModeSchema` ~`:282`, `AggregatorYamlSchema` ~`:332`)
- Modify: `packages/network-config/src/loader.ts` (`resolveDomains` ~`:497`)
- Modify: `packages/network-config/src/testing.ts` (builders accept `voice_bots` / `default_voice_bots` via `aggregator` overrides if not already possible)
- Create: `apps/api/src/services/voice-bots/index.ts`
- Test: `packages/network-config/src/__tests__/loader.test.ts`, `packages/network-config/src/__tests__/voice-bots-schema.test.ts`, `apps/api/src/services/voice-bots/index.test.ts`

**Interfaces:**

- Produces (network-config `./interface`):
  - `VoiceBotSchema` / `type VoiceBot = { key: string; display_name: string; phone: string; languages: string[]; domains: string[]; description?: string }`
  - `RegistrationModeSchema` gains `offers?: ('voice' | 'form')[]`
  - `AggregatorYamlSchema.aggregator` gains `voice_bots: VoiceBot[]` (default `[]`) and `default_voice_bots?: Record<string, string>`
- Produces (`apps/api/src/services/voice-bots`):
  - `botsForDomain(domain: string, cfg: ResolvedNetworkConfig): VoiceBot[]`
  - `resolveDefaultVoiceBot(domain: string, cfg: ResolvedNetworkConfig): VoiceBot | null`
  - `resolveVoiceBot(link: { voiceBotKey: string | null; domain: string }, cfg): { bot: VoiceBot | null; fellBack: boolean }`
  - `modeOffers(mode: string, cfg): ('voice' | 'form')[]` — the mode's `offers`, or `['form']` when absent/undeclared
  - `modeOffersVoice(mode: string, cfg): boolean`

- [ ] **Step 1: Write failing schema tests** in `voice-bots-schema.test.ts`:
  - valid block parses; `voice_bots` absent → `[]`
  - duplicate `key` → parse error mentioning `voice_bots`
  - `default_voice_bots: { seeker: 'x' }` where `x` is not listed → error; where `x` lists `domains: [provider]` → error
  - `phone: '12345'` → error (uses `normalisePhone` from `@aggregator-dpg/shared-primitives/phone`; stored value is the normalised E.164)
  - `languages: []` / `domains: []` → error
  - `offers: ['voice','voice']` → error; `offers` absent → parses
- [ ] **Step 2: Write failing loader test** in `loader.test.ts`: a YAML with a bot `domains: [nope]` (not a network domain) → `load()` returns `err` with code `DOMAIN_RESOLUTION_FAILED` and a message naming `voice_bots` and `nope`; same for a `default_voice_bots` key `nope`.
- [ ] **Step 3: Run** `pnpm --filter @aggregator-dpg/network-config test` → new tests FAIL.
- [ ] **Step 4: Implement** the schemas (refines on `AggregatorYamlSchema` for uniqueness/default checks; phone check via `normalisePhone` in a `.transform`) and the domain-id check in `resolveDomains` after `order` is built.
- [ ] **Step 5: Run** the package tests → PASS. `pnpm --filter @aggregator-dpg/network-config build` succeeds.
- [ ] **Step 6: Write failing helper tests** in `apps/api/src/services/voice-bots/index.test.ts` using `buildBlueDotConfig` with bots `a` (seeker), `b` (seeker), `p` (provider):
  - `resolveDefaultVoiceBot('seeker')` → `null` with two seeker bots and no default; → `a` with `default_voice_bots: { seeker: 'a' }`; → `p` for provider (only one serves it); → `null` with `voice_bots: []`
  - `resolveVoiceBot({ voiceBotKey: 'b', domain: 'seeker' })` → `{ bot: b, fellBack: false }`
  - key `'gone'` → `{ bot: <seeker default>, fellBack: true }`; key `'p'` on a seeker link → `{ bot: <seeker default>, fellBack: true }`, never `p`
  - key `null` → `{ bot: <default>, fellBack: false }`
  - `modeOffers('voice', cfg)` → `['form']`; `modeOffers('voice_or_form', cfg)` → `['voice','form']`; `modeOffers('undeclared', cfg)` → `['form']`
- [ ] **Step 7: Run** `pnpm --filter @aggregator-dpg/api test -- src/services/voice-bots` → FAIL; implement; → PASS.
- [ ] **Step 8: Commit** `feat(api): add per-instance voice-bot config and resolution`

### Task 2: `voice_bot_key` on registration links

**Files:**

- Modify: `packages/db-schema/src/schema.ts:524-554` (add `voiceBotKey: text('voice_bot_key')`, nullable, after `registrationMode`)
- Create: `apps/api/drizzle/migrations/00NN_registration_links_voice_bot_key.sql` (+ journal/snapshot) via `pnpm --filter @aggregator-dpg/api db:generate --name registration_links_voice_bot_key`
- Modify: `apps/api/src/services/registration-links-store/interface.ts` (`RegistrationLink.voiceBotKey: string | null`, `CreateRegistrationLinkInput.voiceBotKey?: string | null`)
- Modify: `apps/api/src/services/registration-links-store/postgres.ts` (`create` ~`:36`, row mapper ~`:263`)
- Test: `apps/api/src/services/registration-links-store/__tests__/postgres.test.ts`

**Interfaces:**

- Produces: `RegistrationLink.voiceBotKey: string | null`; `CreateRegistrationLinkInput.voiceBotKey?: string | null` (omitted → `null`). `UpdateDraftInput` unchanged (immutable).

- [ ] **Step 1: Failing tests:** create with `voiceBotKey: 'up_hindi'` → returned row has it; create without → `null`; mapper reads a row with `voice_bot_key = null` → `null`.
- [ ] **Step 2: Run** → FAIL. **Step 3:** add the column, regenerate the migration (check the SQL is a single `ALTER TABLE "registration_links" ADD COLUMN "voice_bot_key" text;` and the journal `when` exceeds every earlier entry), update interface + store. Fix every other `RegistrationLink` literal the typecheck flags (test stubs: add `voiceBotKey: null`).
- [ ] **Step 4: Run** `pnpm --filter @aggregator-dpg/api test` and `pnpm -w typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(api): store the voice bot on registration links`

### Task 3: Link create, link responses, coordinator bot list

**Files:**

- Modify: `apps/api/src/routes/registration-links.ts` (`CreateLinkBodySchema` ~`:85-110`, create handler after `:231`, `LinkResponseSchema` ~`:149`, `buildResponse` ~`:709`; new route `GET /v1/links/voice-bots`)
- Modify: `apps/api/src/errors/codes.ts` (three codes, next to `INVALID_REGISTRATION_MODE` `:540`)
- Regenerate: `openapi.json` (`pnpm --filter @aggregator-dpg/api spec:dump`), `policy/rbac/edge/routes.json` (`pnpm --filter @aggregator-dpg/api routes:dump`)
- Test: `apps/api/src/routes/registration-links.voice-bot.test.ts` (copy the harness of `registration-links.registration-mode.test.ts`)

**Interfaces:**

- Consumes: Task 1 helpers; Task 2 `voiceBotKey`.
- Produces: create body `voice_bot_key?: string` (regex `^[a-z][a-z0-9_]*$`); link response adds `voice_bot_key: string | null` and `voice_bot: { key, display_name, phone, languages, description? } | null` (resolved via `resolveVoiceBot`); `GET /v1/links/voice-bots?domain=<id>` → `200 { voice_bots: VoiceBot-without-domains[], default_voice_bot_key: string | null }`, `rbac: { capability: 'profiles.onboard' }`, domain must be in `networkCfg.domainIds` and served by the caller (`requireServedDomain`) else 400 / 403 as link create does.

- [ ] **Step 1: Failing tests**, one per spec §3 table row, with config bots `a`,`b` (seeker), `p` (provider), mode `voice_or_form` declared:
  - mode `form` + `voice_bot_key: 'a'` → 400 `SCHEMA_VALIDATION`, `fields.voice_bot_key`
  - mode `form`, no key → 201, stored `voiceBotKey: null`
  - `voice_or_form` + `'a'` on seeker → 201, response `voice_bot_key: 'a'`, `voice_bot.phone` = a's phone
  - `voice_or_form` + `'zzz'` → 400 `INVALID_VOICE_BOT`, `fields.configured` = `['a','b']`
  - `voice_or_form` + `'p'` on seeker → 400 `INVALID_VOICE_BOT`
  - `voice_or_form`, no key, `default_voice_bots.seeker = 'a'` → 201, stored `'a'`, response `voice_bot.key = 'a'`
  - `voice_or_form`, no key, two seeker bots, no default → 400 `VOICE_BOT_REQUIRED`
  - `voice_or_form`, no key, `voice_bots: []` → 201, `voice_bot: null`
  - `PATCH /v1/links/:id` with `voice_bot_key` → 400 (unknown key), unchanged behaviour
  - `GET /v1/links/voice-bots?domain=seeker` → both seeker bots, not `p`, `default_voice_bot_key` per the helper; unknown domain → 400
- [ ] **Step 2: Run** `pnpm --filter @aggregator-dpg/api test -- src/routes/registration-links.voice-bot.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add the error catalogue entries (title/detail/hint in the existing style). Validation runs after the mode check and before the slug loop; pass `voiceBotKey` to `store.create`.
- [ ] **Step 4: Run** the new file and `src/routes/registration-links*.test.ts` → PASS; run `spec:dump` and `routes:dump`, commit the regenerated files.
- [ ] **Step 5: Commit** `feat(api): pick a voice bot when creating a link`

### Task 4: Public resolve returns `offers` and `voice_bot`

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` (`ResolveLinkResponseSchema` `:66`, resolve handler `:158-204`)
- Test: `apps/api/src/routes/public-registration-links.voice-or-form.test.ts` (harness from `public-registration-links.registration-mode.test.ts`; its stub store needs a third link)

**Interfaces:**

- Consumes: `modeOffers`, `resolveVoiceBot`.
- Produces: resolve body adds `offers: ('voice'|'form')[]` and `voice_bot: { display_name: string; languages: string[]; description?: string } | null` (no `phone`, no `key`). `offers` drops `voice` when `bot` is `null`.

- [ ] **Step 1: Failing tests:**
  - existing `voice` link: body deep-equals the previous body plus `offers: ['form']`, `voice_bot: null` (assert by omitting the two keys and comparing to a snapshot of today's fields)
  - `voice_or_form` link with key `a` → `offers: ['voice','form']`, `voice_bot.display_name` = a's; `JSON.stringify(body)` does not contain a's phone
  - change a's `phone` in the config passed to `_setNetworkConfig`, resolve again → the voice submit (Task 5) returns the new number (put this assertion in Task 5's file; here assert display name changes)
  - key `gone`, seeker default `b` → `voice_bot` is b; logs nothing containing a phone (spy on `req.log` not needed — assert response only)
  - key `p` on a seeker link with no seeker default and two seeker bots → `offers: ['form']`, `voice_bot: null` (Review Focus 1)
  - `voice_or_form` with `voice_bots: []` → `offers: ['form']`, `schema` present (form path works)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; log the fallback at `warn` with `link_id`, `voice_bot_key` only.
- [ ] **Step 4: Run** the new file and all `public-registration-links*.test.ts` → PASS. Regenerate `openapi.json`.
- [ ] **Step 5: Commit** `feat(api): resolve the voice bot on public links`

### Task 5: Voice-request endpoint

**Files:**

- Modify: `apps/api/src/routes/public-registration-links.ts` (new route; extract helpers)
- Create: `apps/api/src/routes/public-registration-identity.ts` — the identity/consent checks shared by both routes
- Test: `apps/api/src/routes/public-registration-links.voice-request.test.ts`

**Interfaces:**

- Consumes: `resolveVoiceBot`, `modeOffersVoice`, `SignalStackWriterFake.seedOwnUser` / `seedForeignUser` (`packages/signalstack-writer/src/memory.ts:229-241`).
- Produces:
  - `POST /public/v1/aggregators/:orgSlug/voice-requests/:slug`, `rbac: { access: 'public' }`, response `200 { existing: boolean; voice_bot: { display_name: string; phone: string; languages: string[] } }`, errors `400, 404, 409, 410, 429, 502, 503`.
  - In `public-registration-identity.ts`: `checkAccountOnlyBody(rawBody, identity, opts: { requirePhone: boolean; allowEmail: boolean }): void` (throws the same `httpError`s the submit route throws today) and `resolveConsentAndAge(body, opts: { consentRequired: boolean; withItem: boolean }): { compliance?: ...; age?: number; isMinor: boolean }` (strips the keys it reads). The submit route calls them with `{ requirePhone: false, allowEmail: true }` / `withItem` per shape.

- [ ] **Step 1: Failing tests** (fake DB records inserted `outcome`; spy `vi.spyOn(writer, 'onboard')`):
  - new phone → 200 `{ existing: false, voice_bot: { phone: a.phone, … } }`; `onboard` called once with `submit_mode: 'account_only'`, `channel: 'link'`, `source_id: LINK_ID`, `actingOrgId: ORG_ID`, compliance `[user_terms, user_privacy]` (no `profile_creation`); stored outcome `passed`
  - `seedOwnUser` phone → 200 `existing: true`, `onboard` not called, outcome `skipped`
  - `seedForeignUser` phone → 200 `existing: true`, `onboard` not called (never 409)
  - phone `'098765 43210'` matching a seeded own user `+919876543210` → `existing: true` (Review Focus 2)
  - probe returns `err` → 502, no `link_submissions` insert
  - body with `email` or any profile field → 400 `REGISTRATION_MODE_MISMATCH`; no phone → 400 `SCHEMA_VALIDATION`; adult without consent on a consent-required domain → 400 `CONSENT_REQUIRED`
  - `form` link → 409 `VOICE_BOT_UNAVAILABLE`; `voice_or_form` with `voice_bots: []` → 409 (Review Focus 3)
  - config phone for `a` changed → response carries the new phone
  - rate limiter `consume` called with namespace `link-submit` and key `${ORG_SLUG}:${SLUG}:<ip>`; `allowed: false` → 429
  - minor (`year_of_birth` → age ≤ 18): no compliance, no age sent, same as today's account-only rule
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Extract** the helpers from the submit handler (`:274-316`, `:357-393`) and switch the submit route to them. **Run** every existing `public-registration-links*.test.ts` → PASS unchanged before writing the new route.
- [ ] **Step 4: Implement the route** in spec §6 order (rate limit → link → offers/bot → body → phone normalise → org id → probe → skip or transaction + onboard → 200). Map `onboard` failures exactly as the submit route (reuse its mapping by extracting it alongside the helpers if needed). Log `operation: 'public.voiceRequest'` with `link_id`, `voice_bot_key`, `existing`, `outcome`, `latency_ms`.
- [ ] **Step 5: Run** `pnpm --filter @aggregator-dpg/api test` → PASS. Regenerate `openapi.json` and `routes.json`; `pnpm dep-check`, `pnpm -w lint`, `pnpm -w typecheck` clean.
- [ ] **Step 6: Commit** `feat(api): add the voice-bot path for two-option links`

### Task 6: Web BFF routes and service types

**Files:**

- Create: `apps/web/src/app/api/[org]/[slug]/voice-request/route.ts` (copy `submit/route.ts`: same timeout, body cap, request-id, error envelope; upstream path `/public/v1/aggregators/:org/voice-requests/:slug`)
- Create: `apps/web/src/app/api/links/voice-bots/route.ts` (`GET`, `callApi('/v1/links/voice-bots?domain=…')`, auth like `api/links/route.ts`)
- Modify: `apps/web/src/services/onboarding.service.ts` (`ApiRegistrationLinkSchema` `:19` adds `voice_bot_key`, `voice_bot`; create input adds `voice_bot_key?`; new `listVoiceBots(domain)` + `VoiceBotSchema`)
- Test: `apps/web/src/__tests__/app/api/voice-request.route.test.ts`, `apps/web/src/__tests__/app/api/links-voice-bots.route.test.ts`, `apps/web/src/__tests__/services/onboarding.service.test.ts`

**Interfaces:**

- Produces: `listVoiceBots(domain: string): Promise<{ voice_bots: VoiceBotOption[]; default_voice_bot_key: string | null }>`; `type VoiceBotOption = { key; display_name; phone; languages: string[]; description?: string }`; `POST /api/:org/:slug/voice-request` passes status and body through.

- [ ] **Step 1: Failing tests** mirroring `submit.route.test.ts` (forwards body, propagates 200/409/429 with `Retry-After`, oversized body 413, upstream timeout → 504 envelope) and `links.route.test.ts` (unauthenticated → 401; forwards `domain` query).
- [ ] **Step 2: Run** `pnpm --filter @aggregator-dpg/web test -- voice` → FAIL. **Step 3: Implement.** **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(web): proxy the voice-request and voice-bot list endpoints`

### Task 7: Coordinator bot picker

**Files:**

- Modify: `apps/web/src/app/(protected)/onboarding/_components/RegistrationLinksSection.tsx` (form state `:40-64`, default-mode effect `:322-330`, mode select `:472-490`, link list rendering)
- Create: `apps/web/src/app/(protected)/onboarding/_components/VoiceBotPicker.tsx`
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json` (`registration_mode.voice_or_form.label`, `…hint`, picker strings)
- Test: `apps/web/src/__tests__/app/(protected)/onboarding/RegistrationLinksSection.test.tsx`, new `VoiceBotPicker.test.tsx` beside it

**Interfaces:**

- Consumes: `listVoiceBots`, `cfg.registration_modes[key].offers` (already passed through by the `{ ...mode }` spread in `apps/api/src/routes/aggregator-config.ts:194-201`; add `offers` to the web's config Zod schema if it strips unknown keys).
- Produces: `VoiceBotPicker({ domain, value, onChange }: { domain: string; value: string | null; onChange: (key: string | null) => void })`. `null` = nothing picked yet (sent as no `voice_bot_key`; the API stores the default's key). A pick, the default included, reports its key.

- [ ] **Step 1: Failing tests:**
  - default mode is `voice_or_form` when declared, else `form` (existing fallback)
  - picker hidden for `form`/`voice`; shown for `voice_or_form`
  - many bots: radio rows show display name, phone, languages, description; default preselected; submitting with the default selected sends no `voice_bot_key`; picking another sends its key
  - one bot: read-only row, no radios; none: the note "No voice bot yet — the link offers Register / sign in until one is configured"
  - domain switch (seeker → provider) refetches and resets a chosen key that the provider list lacks (Review Focus 5)
  - link list shows the bot's display name and number for links with `voice_bot`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with the existing select/radio styling of the section; fetch via TanStack Query (the section's existing data pattern), not `useEffect`.
- [ ] **Step 4: Run** the web suite → PASS.
- [ ] **Step 5: Commit** `feat(web): pick a voice bot when creating a link`

### Task 8: Public first screen, voice form and result

**Files:**

- Modify: `apps/web/src/app/[org]/[slug]/page.tsx` (`ResolveResponseSchema` gains `offers` default `['form']`, `voice_bot` default `null`; render `VoiceOrFormView` when `offers` includes `voice`, else `PublicRegistrationView` exactly as today)
- Create: `apps/web/src/app/[org]/[slug]/VoiceOrFormView.tsx` (first screen + voice flow; spec §8 sketches)
- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx` (two optional props: `startWithForm?: boolean` skips the inner chooser; `onBack?: () => void` renders the Back control on the form and is called instead of returning to the inner chooser). Defaults keep today's behaviour.
- Modify: `apps/web/src/i18n/messages/{en,hi,kn}.json` (`profile.public_reg.voice_*`)
- Test: `apps/web/src/__tests__/views/VoiceOrFormView.test.tsx`; existing `PublicRegistrationView.*.test.tsx` must pass unchanged

**Interfaces:**

- Consumes: resolve `offers`, `voice_bot`; BFF `POST /api/:org/:slug/voice-request`; `MinimalIdentityForm` with `requirePhone` and `identity` minus `email`; `SignalsSignInCta` / `useSignalsHandoffUrl`.
- Produces: `VoiceOrFormView(props: PublicRegistrationViewProps & { voiceBot: { display_name: string; languages: string[]; description?: string } })`.

Copy (en; translate for hi/kn):

- `voice_chooser_title`: "How would you like to register?"
- `voice_chooser_subtitle`: "Talk to our voice assistant, or fill the form yourself."
- `voice_cta`: "Talk to the voice assistant"
- `voice_form_cta`: "Register with the form"
- `voice_form_title`: "Talk to the voice assistant"
- `voice_form_subtitle`: "Give your name and number, then call us."
- `voice_continue`: "Continue"
- `voice_done_new_title`: "You're all set"
- `voice_done_existing_title`: "You already have an account"
- `voice_done_body`: "Call {name} to build your profile. It speaks {languages}."
- `voice_call_cta`: "Call {phone}"
- `voice_unavailable`: "The voice assistant is not available right now. Please register with the form."

- [ ] **Step 1: Failing tests:**
  - first screen shows three buttons in order: voice (primary, with bot name + languages), "Register with the form", sign-in (only when `useSignalsHandoffUrl` returns a URL)
  - voice → form has name + phone, no email; Back returns to the first screen
  - submit → 200 `existing: false` → "You're all set", a link with `href="tel:+911234567890"` and text "Call +91 12345 67890"
  - 200 `existing: true` → "You already have an account" + the same `tel:` link
  - 409 `VOICE_BOT_UNAVAILABLE` → first screen without the voice button and the `voice_unavailable` notice (Review Focus 3)
  - "Register with the form" → the full form directly (no inner chooser); its Back returns to the first screen
  - "Register another person" resets to the first screen with empty fields
  - `offers: ['form']` → `page.tsx` renders `PublicRegistrationView` (existing tests cover its output)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** reusing the existing card, chooser button classes, error banner and green done panel from `PublicRegistrationView.tsx:856-930`. Display the phone grouped for reading; the `href` uses the raw E.164.
- [ ] **Step 4: Run** `pnpm --filter @aggregator-dpg/web test` → PASS; `pnpm -w lint typecheck` clean.
- [ ] **Step 5: Commit** `feat(web): add the two-option public registration page`

### Task 9: Instance config and docs

**Files:**

- Modify: `config/aggregator.config.example.yaml`, `config/blue_dot/aggregator.config.yaml`, `config/blue_dot/{up-gzb,upsdm,ka-dhwd}/aggregator.config.yaml`, `config/purple_dot/aggregator.config.yaml`, `config/purple_dot/alimco/aggregator.config.yaml`, `config/orange_dot/onetac/aggregator.config.yaml`
- Modify: `config/README.md`
- Modify: `apps/web/src/__tests__/fixtures/aggregator-config.{blue_dot,purple_dot}.json` only if a config-snapshot test requires it (else leave)

- [ ] **Step 1:** In each file add, next to the existing modes:
  ```yaml
  voice_or_form:
    label_i18n_key: registration_mode.voice_or_form.label
    submission_shape: account_and_profile
    public_hint_i18n_key: null
    signals_cta: true
    offers: [voice, form]
  ```
  and at `aggregator` level `voice_bots: []` with a commented example entry (key, display_name, phone, languages, domains, description) and `default_voice_bots`. Keep `voice` and `form` (comment: removing either changes old links).
- [ ] **Step 2:** `config/README.md`: document the block, the per-domain default rule, that a number change needs a config rollout, and `AGGREGATOR_ONBOARDING_ENABLED=voice_or_form` to make new links two-option only.
- [ ] **Step 3: Verify** every config loads: run the network-config loader test that iterates repo configs if one exists, else `pnpm --filter @aggregator-dpg/api test -- network-config` and boot-check with `AGGREGATOR_NETWORK=<each>` via the existing config validation script (`pnpm -w test` at minimum).
- [ ] **Step 4: Commit** `feat(config): declare the two-option mode and voice-bot lists`

### Task 10: Whole-branch verification and hand-off

- [ ] **Step 1:** `pnpm -w build && pnpm -w lint && pnpm -w typecheck && pnpm -w test && pnpm dep-check` → all green; `git diff --exit-code openapi.json policy/rbac/edge/routes.json` after re-running both dumps.
- [ ] **Step 2:** Split commits into the three stacked branches (`gh stack init --base feature feat/1122-qr-two-options-api`, then `add …-web`, `add …-config`), docs in the config PR.
- [ ] **Step 3: Stop.** Report results to the user and ask before `gh stack push` / `submit`. After merge into `feature`, propose the cherry-pick PRs into `hotfix/up-speedrun` and the migration renumbering against #1121 (spec §10).
