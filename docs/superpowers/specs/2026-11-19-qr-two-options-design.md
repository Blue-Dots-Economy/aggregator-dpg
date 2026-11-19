# QR form with two options: talk to the voice bot, or register / sign in

**Ticket:** aggregator-dpg#1122 (child of bluedots-infra-deployments#146, the UP speed-run epic).
**Base:** `feature` at `011a95c3`. Code references below are to that commit.

## Why

Today a coordinator picks a link type when creating a QR link: the full form (`form`) or name and phone (`voice`). For UP we want one link that offers both: a participant who would rather speak than type gives name and phone and gets the voice bot's number to call; anyone else registers or signs in as today.

Two facts shape the design:

- Live links cannot be edited, and a new link means a new URL, which breaks QR codes already printed. A voice-bot number will change over the life of a printed QR, so the link must not hold the number.
- The voice bot already lists a caller's profiles and offers to use one or create a new one. So the voice-bot path creates **the account only**. An empty draft profile made here would show up on the call as a spurious choice. (The ticket was edited to say this on 2026-11-19.)

## Goals

1. A new registration mode that offers both options on one public page.
2. A per-instance list of voice bots in config. The coordinator picks one per link and sees its details.
3. The link stores the bot's key. The number is read from config every time the form opens, so a config change reaches every live link with the same URL.
4. Voice-bot path: name, phone and consent. Create the account if the phone is new, attributed to the link's coordinator and link. Create nothing if it exists. In both cases show the number as a `tel:` link, and say "You already have an account" when it existed.
5. Register / sign in on the new link behaves exactly as a `form` link does today.
6. English, Hindi and Kannada text.

## Non-goals

- Call-back ("we'll call you") — deferred to #1123.
- Re-pointing a live link to another bot. The ticket marks it optional, only if product asks.
- Editing bots from the console. Bots are config; a change ships through the instance's config rollout.
- Any change to `voice` or `form` links, to the existing submit route, or to Signals.
- CAPTCHA. The public routes rely on the existing per-(org, slug, IP) rate limit. There is no call-back cost on this path.

## Anti-goals (failure even if it "works")

- A live link showing a number that is no longer in config, or a broken `tel:` link.
- The voice-bot path creating a profile, or a second account for a phone that already has one.
- The voice-bot path refusing a participant because another coordinator onboarded them (today's 409 on name-and-phone links).
- Any change in what an existing `voice` or `form` link renders or returns.

## Approaches considered

- **A. New mode `voice_or_form` with its own voice endpoint (chosen).** The new behaviour lives in new code. The Register path reuses today's submit route untouched, so old links are unchanged by construction. Instances switch new links over with the existing `AGGREGATOR_ONBOARDING_ENABLED` allow-list, which gates only link creation.
- **B. No new mode; a bot on a `form` link adds the voice option.** Fewer config pieces, but the existing submit route gains a branch with different success and conflict rules, and the allow-list can no longer turn the two-option form on or off per instance. Rejected.
- **C. Bots in a DB table managed in the console.** Number changes without a deploy, but needs a migration, a screen and permissions; the ticket asks for config and number changes are rare. Rejected.

## Design

### 1. Config (`packages/network-config`)

Two additive changes to `AggregatorYamlSchema` (`packages/network-config/src/interface.ts:332`):

```yaml
aggregator:
  voice_bots:
    - key: up_hindi # snake_case, unique
      display_name: UP Rozgar Sahayak
      phone: '+911234567890' # E.164; validated at load
      languages: [hi] # at least one
      domains: [seeker] # participant types it serves; at least one network domain id
      description: Hindi, for seekers in UP # optional
  default_voice_bots: # optional; per domain, must name a bot serving that domain
    seeker: up_hindi

  registration_modes:
    voice_or_form:
      label_i18n_key: registration_mode.voice_or_form.label
      submission_shape: account_and_profile
      public_hint_i18n_key: null
      signals_cta: true
      offers: [voice, form]
```

- `VoiceBotSchema`: `key`, `display_name`, `phone`, `languages: string[] (min 1)`, `domains: string[] (min 1)`, `description?`. `voice_bots` defaults to `[]`; `default_voice_bots` is an optional `record<domain, key>`.
- A bot serves only the domains it lists; today each UP bot serves one. Every rule below (default, picker, create check, fallback) considers only bots whose `domains` include the link's domain.
- Load-time checks (refine on the root schema, so a bad config fails at boot): keys unique; each `default_voice_bots` entry names a listed bot that serves that domain; `phone` passes the shared `normalisePhone`. Once the network resolves, a bot `domains` entry or `default_voice_bots` key that is not a network domain id fails boot, like an unknown domain elsewhere in config.
- `RegistrationModeSchema` gains optional `offers: ('voice' | 'form')[]` (min 1, unique). Absent means today's behaviour, so `voice` and `form` entries need no edit. `submission_shape` stays and describes the `form` path of a mode that offers it.
- **Effective default bot for a domain** (one shared helper, `resolveDefaultVoiceBot(domain, cfg)`): `default_voice_bots[domain]` if set; else the only bot serving that domain when exactly one does; else none.
- Config is read once at startup. A number change is a config edit plus the instance's normal rollout/restart; URLs and QRs do not change.

### 2. Link storage (`apps/api`, new migration)

- New nullable column `registration_links.voice_bot_key text`. Not `context`: `context` is free-form data the coordinator's browser sends and is copied into every submission snapshot.
- `RegistrationLink` / `CreateRegistrationLinkInput` gain `voiceBotKey: string | null`; the postgres and memory stores and the `./testing` fake carry it.
- The column is immutable after create, like `registration_mode`. `PATCH` on a draft does not accept it.

### 3. Link create (`POST /v1/links/create`, `apps/api/src/routes/registration-links.ts:181`)

Body gains optional `voice_bot_key` (snake_case regex). After the existing mode check (`:217-231`):

| Mode offers voice? | `voice_bot_key` sent                                         | Result                                                                                 |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| no                 | yes                                                          | 400 `SCHEMA_VALIDATION` (`voice_bot_key` not allowed for this mode)                    |
| no                 | no                                                           | stored `null`                                                                          |
| yes                | a configured key serving the link's domain                   | stored                                                                                 |
| yes                | an unknown key, or one that does not serve the link's domain | 400 `INVALID_VOICE_BOT`, `fields.configured` lists the keys serving that domain        |
| yes                | no, the domain has an effective default                      | stored `null`; the link follows the default                                            |
| yes                | no, several bots serve the domain and none is its default    | 400 `VOICE_BOT_REQUIRED`                                                               |
| yes                | no, no bot serves the domain                                 | stored `null`; the link offers Register only until a default bot exists for the domain |

A stored key means the coordinator chose that bot; `null` means "the instance default for the link's domain". So a link created before any bot is configured (the UP preload ships `voice_bots: []` first) starts offering voice as soon as a default bot is added, with the same URL and QR. A chosen key does not move when `default_voice_bots` changes; only a removed bot falls back (§5).

Link responses (`LinkResponseSchema`, `:149`, built at `:709`) add `voice_bot_key` and, when it resolves, `voice_bot: { key, display_name, phone, languages, description }` so the coordinator's link list and QR card can show which bot a link uses.

The default mode when the body omits `registration_mode` stays as today (`form` if enabled). The coordinator UI sends the mode explicitly.

### 4. Coordinator picker data (`GET /v1/links/voice-bots`, new)

Authenticated, `rbac: { capability: 'profiles.onboard' }` like link create. Takes `?domain=<id>` (must be a domain the caller serves) and returns `{ voice_bots: [...full details of bots serving it], default_voice_bot_key: string | null }` (the domain's effective default). Not added to the public `GET /v1/aggregator-config` (`apps/api/src/routes/aggregator-config.ts`, `access: 'public'`), so the bot numbers are not published wholesale. `routes:dump` regenerates `policy/rbac/edge/routes.json`.

### 5. Public resolve (`GET /public/v1/aggregators/:orgSlug/links/:slug`)

Additive fields on `ResolveLinkResponseSchema` (`apps/api/src/routes/public-registration-links.ts:66`):

- `offers: ('voice' | 'form')[]` — always present. Old modes: `['form']`, for any mode without `offers`, so the web keeps branching on `submission_shape` as today. New mode: the mode's `offers`, with `voice` dropped when no bot resolves.
- `voice_bot: { display_name, languages, description } | null` — no phone. The number is returned only after the participant submits name and phone (§6), which is the ticket's order of screens.

Bot resolution (one helper, `resolveVoiceBot(link, cfg)`): the link's `voice_bot_key` if still configured and still serving the link's domain; else the effective default for the link's domain; else `null`. Never a key that is not in config. A fallback is logged at `warn` with the link id and the missing key (no phone).

### 6. Voice-bot submit (`POST /public/v1/aggregators/:orgSlug/voice-requests/:slug`, new)

New route in `public-registration-links.ts`, `rbac: { access: 'public' }`.

1. Same rate limit as submit: namespace `link-submit`, key `${orgSlug}:${slug}:${ip}`, `PUBLIC_SUBMIT_RATE_*`. The two routes share the budget.
2. Load the live link (`loadLiveLinkByOrgAndSlug`). If its mode does not offer `voice`, or no bot resolves: 409 `VOICE_BOT_UNAVAILABLE` (the page then shows Register only).
3. Body: the domain's identity name and phone keys, `consent_terms`, `consent_privacy`, and `year_of_birth` / `age` for guardian-gated domains — the same allow-list and consent/age rules as today's `account_only` branch (`:274-316`, `:357-393`). **Phone is required** (the bot identifies the caller by phone); email is not accepted. Extract the shared identity/consent checks from the submit handler into a helper used by both routes, without changing the submit route's behaviour.
4. Normalise the phone (`normalisePhone`), read the coordinator's `signalstackOrgId` (503 `SIGNALSTACK_ORG_NOT_REGISTERED` when null, as today).
5. **Probe first:** `probeUser({ actingOrgId, phoneNumber, network, domain })` (read-only; already used by `routes/public-lookup.ts:143`). A probe failure answers 502 `SIGNALSTACK_PUSH_FAILED`-style, with nothing written.
6. `user_exists: true` (this coordinator's or another's): **do not call `onboard`**. Insert the `link_submissions` row with outcome `skipped`. `existing = true`.
7. `user_exists: false`: in one transaction, as the submit route does, insert a `link_submissions` row and call `onboard` with `submit_mode: 'account_only'`, `channel: 'link'`, `source_id: link.id`, terms + privacy compliance and age for adults. Outcome `passed`, `existing = false`.
8. Respond `200 { existing: boolean, voice_bot: { display_name, phone, languages } }`. Never 409 for an existing account.

Signals failures on `onboard` map exactly as the submit route maps them (502 `SIGNALSTACK_PUSH_FAILED`, `U18_REGISTRATION_REDIRECT`, etc.).

Why probe first instead of a single `onboard`: an account-only `onboard` for a user this org already owns is not a no-op in Signals (`handleAccountOnlyExistingUser`, `Signals-DPG/apps/api/src/routes/v1/admin/participant.ts`, `origin/feature`). It records consent again, writes `age`, and with `age` calls `promoteEligibleDraftsForUser`, which can turn the user's draft profiles live. Skipping `onboard` for an existing phone keeps "create nothing" true. The remaining race (two taps both probe "new") is harmless: Signals keys the user by phone, so the second `onboard` finds the account and creates no second one; at worst it re-records consent once. No writer change is needed.

Logs: `operation: 'public.voiceRequest'`, `link_id`, `voice_bot_key`, `existing`, `outcome`, `latency_ms`. Never the phone or name.

### 7. Coordinator UI (`apps/web`, `RegistrationLinksSection.tsx`)

- The mode picker lists `voice_or_form` with its label. When it is enabled it is the default selection.
- When the chosen mode offers voice: a bot picker fed by `GET /v1/links/voice-bots`, each option showing display name, number, languages and description. Preselected to the effective default (sent as no key, so the link follows the default); shown as read-only text when exactly one bot; a note "No voice bot yet — the link offers Register / sign in until one is configured" when none.
- The link list / QR card shows the bot's display name and number for links that have one.

### 8. Public page (`apps/web/src/app/[org]/[slug]/`)

Our own screens; product did not supply any. They reuse the existing public card, chooser buttons, `MinimalIdentityForm`, error banner and green done panel, so the page looks like today's.

**First screen** (`offers` has both). One flat chooser with three buttons, so a participant reaches any path in one tap. The ticket's "Register / sign in" option is the two outlined buttons, which are today's chooser buttons unchanged.

```
┌─────────────────────────────────────────────┐
│  How would you like to register?            │
│  Talk to our voice assistant, or fill the   │
│  form yourself.                             │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ 📞 Talk to the voice assistant         │  │  primary (brand colour)
│  │    UP Rozgar Sahayak · हिन्दी            │  │  bot name + languages
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │ Register with the form                │  │  outlined (today's Register)
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │ Already registered? Sign in           │  │  outlined (SignalsSignInCta)
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

When the Signals hand-off is not configured for the instance, the sign-in button is absent, as today.

**Voice form.** `MinimalIdentityForm` in a phone-required, no-email variant, with today's consent box and year of birth where the domain needs it.

```
┌─────────────────────────────────────────────┐
│  ← Back                                     │
│  Talk to the voice assistant                │
│  Give your name and number, then call us.   │
│  Name        [__________________________]   │
│  Mobile      [+91 ______________________]   │
│  [✓] I accept the Terms and Privacy Policy  │
│  ┌───────────────────────────────────────┐  │
│  │ Continue                              │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Result.** The green done panel. The number is a full-width `tel:` button; the existing-account line shows only when `existing`.

```
┌─────────────────────────────────────────────┐
│  ✓ You're all set            (new account)  │
│  ✓ You already have an account  (existing)  │
│  Call UP Rozgar Sahayak to build your       │
│  profile. It speaks हिन्दी.                   │
│  ┌───────────────────────────────────────┐  │
│  │ 📞 Call +91 12345 67890               │  │  <a href="tel:+911234567890">
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │ Register another person               │  │  back to the first screen
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

Behaviour:

- Voice form posts through a new BFF route `apps/web/src/app/api/[org]/[slug]/voice-request/route.ts`, mirroring the existing submit proxy. A 409 `VOICE_BOT_UNAVAILABLE` (the bot was removed between page load and submit) returns to the first screen without the voice button and shows a short notice.
- "Register with the form" opens today's full form; its Back returns to the first screen.
- `offers` is `['form']`: the page renders exactly as today (today's two-button chooser or the form).
- New text in `apps/web/src/i18n/messages/{en,hi,kn}.json` under `registration_mode.voice_or_form` and the `profile.public_reg` group (`voice_*` keys). Hindi and Kannada strings need a native-speaker check before release.

**Coordinator bot picker** (§7), in the create-link form below the campaign type:

```
Voice assistant
( ) UP Rozgar Sahayak   +91 12345 67890   हिन्दी
    Hindi, for seekers in UP
(•) UP Kannada Bot      +91 98765 43210   ಕನ್ನಡ      ← default preselected
```

One bot: the same row as read-only text. None: the note from §7.

### 9. Instance config and rollout

- Add `voice_or_form` and an empty `voice_bots: []` to every instance config that declares `voice`: `config/blue_dot/aggregator.config.yaml` and its brands (`up-gzb`, `upsdm`, `ka-dhwd`), `config/purple_dot/aggregator.config.yaml` and `alimco`, `config/orange_dot/onetac/aggregator.config.yaml`, and `config/aggregator.config.example.yaml`; document the block in `config/README.md`. Real bot entries are added per instance once the numbers are known.
- With `voice_bots: []` the new mode behaves as a `form` link with the Register chooser, so shipping config before numbers is safe.
- To make new links use only the two-option form on an instance, set `AGGREGATOR_ONBOARDING_ENABLED=voice_or_form` (deployment env, bluedots-automation). Existing `voice` / `form` links keep resolving: the allow-list gates link creation only.
- Do not remove `voice` or `form` from any config: `resolveSubmissionShape` falls back to the full form for an undeclared mode, which would change old name-and-phone links.

### 10. Delivery

Normal path: branches from `feature`, one PR per block stacked per `.claude/rules/pull-requests.md` — API (with the `network-config` package change, the migration, `openapi.json`, `routes.json`), Web, Config. Squash into `feature`, then carry each squash commit to `hotfix/up-speedrun` by cherry-pick PR (`feature` holds unrelated work that must not ride along). Migration number: `0039` is also taken by `0039_user_identities_user_type.sql` on the #1121 branch; whichever story merges second regenerates its migration with `pnpm db:generate` on top of the other.

## Tests

- **network-config:** bot schema, unique keys, a default must name a bot serving its domain, unknown domain id fails boot, bad phone fails load, `offers` optional; `resolveDefaultVoiceBot` per domain for 0 / 1 / many serving bots with and without a `default_voice_bots` entry, and a bot serving another domain is never picked.
- **Link create:** every row of the §3 table, including a provider link refused a seeker-only bot; `voice_bot_key` immutable on PATCH; response includes the bot.
- **Resolve:** old modes return `offers: ['form']` and an otherwise byte-identical body; new mode with bot; a bot removed from config, or no longer serving the link's domain, falls back to the domain's default; a provider link never falls back to a seeker-only bot; removed with no default → `offers: ['form']`, `voice_bot: null`; a changed number in config shows on an existing link; no phone in the resolve body.
- **Voice submit:** probe says new → account-only onboard with `channel: 'link'`, `source_id`, the coordinator's acting org, terms + privacy consent, outcome `passed`, `existing: false`, number returned; probe says existing (own or another coordinator's) → `onboard` never called, `existing: true`, outcome `skipped`, 200 not 409; probe failure → 502 and no row; email or profile fields rejected; missing phone 400; consent rules as today; mode without voice / no bot → 409; rate limit shared with submit.
- **Regression:** the existing public submit and resolve tests pass unchanged for `voice` and `form` links.
- **Web:** two-option screen, voice form → result with `tel:` link and the existing-account line, Back navigation, `['form']` renders today's page; coordinator bot picker states (none / one / many).

## Left to the builder

- Error-code catalogue entries for `INVALID_VOICE_BOT`, `VOICE_BOT_REQUIRED`, `VOICE_BOT_UNAVAILABLE` (`apps/api/src/errors/codes.ts`).
- How the shared identity/consent helper is factored out of the submit handler, as long as the submit route's tests pass unchanged.
- Exact component split in the web, within the screens in §8.

## Open with product

- Bot details beyond display name, number, languages and description.
- The real bot list (names, numbers, languages) per instance.
