# QR / form registration — participant consent at submit

**Issues:** [#475](https://github.com/Blue-Dots-Economy/aggregator-dpg/issues/475) (epic #394 stage 3 — T&C linked to QR & Forms) and [#522](https://github.com/Blue-Dots-Economy/aggregator-dpg/issues/522) **Task 2** (form-mode registration consent capture, folded from the completed #526).
**Epic:** [#394](https://github.com/Blue-Dots-Economy/aggregator-dpg/issues/394) · Signals twin epic [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99)
**Date:** 2026-07-27
**Status:** Design — pending review.

**Incorporates:** @AbhiGaddi's Task 2 analysis in #522 (2026-07-27). §4.3 records one technical correction to its proposed mechanism.
**Depends on (Signals, cross-repo):**

- `2026-07-27-consent-version-upgrades-design.md` — the public `GET /consent/active` endpoint and the `409 STALE_CONSENT_VERSION` guard.
- `2026-07-27-consent-external-channels-design.md` — `consent_outcome.state = 'u18_redirect_required'` and the nudge.
- `2026-07-27-consent-point-registry-design.md` — needed only for the voice-callback permission point (§3.3).

---

## 1. Why this is the one channel where the aggregator _does_ collect participant consent

The aggregator cannot consent on a participant's behalf — that is settled, and it is why bulk records an operator attestation instead (`2026-07-27-bulk-upload-operator-attestation-design.md`).

The QR / registration-link form is different: **the participant is the one filling it in.** It is a present turn by the data principal themselves, on a surface the aggregator merely hosts. So real consent can be captured here, and today it is faked instead.

Epic #394 stage 3 states the requirement: the **Signals** registration Terms & Consent must be accepted at **form-submit** time, and the form comes in two types, each with its own consent.

## 2. Current state (verified)

- `MinimalIdentityForm.tsx:130-133` **hardcodes** `consent_terms: true` / `consent_privacy: true` into the payload.
- The visible `consent_call` checkbox is a **client-side gate only** and is never transmitted — the `account_only` submit endpoint rejects unknown fields (`REGISTRATION_MODE_MISMATCH`, #435). The in-code comment says as much.
- The backend push (`public-registration-links.ts:556-557`) sends `terms_accepted` / `privacy_accepted` from `presume_consent`, not from anything the participant did.
- Those two flags are **deprecated and ignored** by Signals (`packages/schemas/src/admin/participant.ts:16-18`); consent is recorded only via `compliance`.

Net: a participant ticks a box, and nothing about that tick is transmitted, validated, or recorded anywhere. This is the "discarded checkbox" §11 of the cross-DPG design flagged.

## 3. The two form types

`resolveSubmissionShape(link.registrationMode, networkCfg)` already resolves a link to one of two shapes. Map #475's two types onto them:

### 3.1 Type (a) — Signals-participant schema form (`account_and_profile`)

The full participant registration: account **and** profile. Requires all three Signals participant consents:

| point              | level | why                                                        |
| ------------------ | ----- | ---------------------------------------------------------- |
| `user_terms`       | user  | platform terms                                             |
| `user_privacy`     | user  | platform privacy policy                                    |
| `profile_creation` | item  | a profile is created, and this is what gates it going live |

`profile_creation` is the one #522 Task 2 does not mention, because Task 2 was scoped to `account_only` (where no profile exists). Without it the profile is created but stays `draft` forever — the participant would have to re-consent in the Signals UI, defeating the point of a self-service form.

### 3.2 Type (b) — Voice-callback registration form (`account_only`)

Account only, no profile. Requires:

| point                       | level | why                                                               |
| --------------------------- | ----- | ----------------------------------------------------------------- |
| `user_terms`                | user  | an account is created                                             |
| `user_privacy`              | user  | an account is created                                             |
| `voice_callback_permission` | user  | "I permit the aggregator to trigger the call on my behalf" (#435) |

No `profile_creation` — there is no profile.

### 3.3 Where the voice-callback permission lives

It is **consent by the participant**, so it belongs in the **Signals** participant ledger, not `aggregator_consent_record` (which is keyed on `subject_type ∈ {org, aggregator}` and must stay operator-only — extending it to participants would blur the boundary this whole design rests on).

The consent-point registry makes this a config-only addition on the Signals side:

```jsonc
"voice_callback_permission": {
  "level": "user",
  "doc_type": "statement",
  "required_at": ["explicit"],
  "versions": [ { "version": 1, "statement": "I permit the aggregator to trigger the call on my behalf.", "effective_from": "2026-08-01" } ]
}
```

`required_at: ["explicit"]` because it is never a blocking platform gate — it is captured when this form offers it. This is a good demonstration of why the registry matters: without it, a new participant consent point is an eight-file change across two repos.

The aggregator's `link_submissions` row keeps the operational record of the submission; the ledger keeps the consent.

> **If the registry spec has not landed**, type (b) ships with `user_terms` + `user_privacy` recorded via `compliance` and the voice-callback permission held only in `link_submissions`, with the ledger row following once the point exists. Flagged as a sequencing dependency rather than a blocker.

## 4. Design

### 4.1 Consent copy comes from Signals, not the aggregator config

The subject is a Signals participant, so the authoritative copy is Signals'. The form fetches it from the new public endpoint:

```
GET /api/v1/consent/active?network=&audience=participant&variant=adult
```

Public and pre-login, per §10 of the cross-DPG design — which is exactly the case this form needs.

The alternative — copying participant terms into the aggregator's `consent.json` — would create a **second source of truth for the same legal document**, in a repo with a different config schema and a separate release cadence. That is the drift this ecosystem already suffers from (two ledgers, two config shapes, no cross-check) and it should not be widened. The aggregator's own `consent.json` stays operator-only.

Rendering reuses the existing `ConsentCheckboxWidget` + read-only Terms/Privacy modal pattern, as #522 Task 2 proposes.

### 4.2 Server-side validation, not a client gate

The submit endpoint accepts a consent block and **validates it server-side**:

```jsonc
"consent": {
  "accepted": ["user_terms", "user_privacy", "profile_creation"],
  "versions": { "user_terms": 1, "user_privacy": 1, "profile_creation": 1 }
}
```

- Any required point for the resolved form type missing → `400 CONSENT_REQUIRED`, naming the missing points. No participant row, no Signals push.
- A version not matching the current one in force → `409 STALE_CONSENT_VERSION`, carrying the current document so the client re-renders.
- This requires **allow-listing the consent block on the `account_only` shape**, which currently rejects unknown fields (`REGISTRATION_MODE_MISMATCH`). That is the #435 unblock #522 Task 2 refers to.

### 4.3 Forward as `compliance`, not the deprecated flags

#522 Task 2's acceptance criterion says _"signalstack push flags reflect submitted consent, not `presume_consent`."_ The intent is right, but the mechanism cannot be the flags: `terms_accepted` / `privacy_accepted` are deprecated and **ignored** by Signals, so making them reflect real consent would still record nothing.

The correct mechanism is the `compliance` array on `/admin/participant`, which exists precisely for a channel where the participant is present:

```jsonc
{
  "name": "…", "phone_number": "+91…", "age": 27,
  "channel": "link",
  "source_id": "‹link id›",
  "compliance": [
    { "key": "user_terms",       "value": true },
    { "key": "user_privacy",     "value": true },
    { "key": "profile_creation", "value": true }
  ],
  "item_state": { … }
}
```

Per the 07-24 Signals design: `compliance` is **accept-only** (any `false` → `CONSENT_DECLINED`; omit a key to skip it), `user_terms`/`user_privacy` are **both-or-none**, and on a guardian-gated domain recording the pair **requires the age**. The form must therefore collect age before it can submit consent on a gated domain — which it needs anyway for §4.4.

Remove `terms_accepted` / `privacy_accepted` from the push, and with the bulk reader also removed, drop `presume_consent` from the configs (see the bulk spec §4 for the sequencing).

### 4.4 U18 → redirect to the app

**No minor establishes consent on this form.** Guardian consent needs the OTP flow, which lives in the Signals UI. This mirrors voice, which cannot serve minors at all.

Flow:

1. The form collects **birth year** (age is derived as `currentYear - birthYear`, matching #331's snapshot model — no birthdate is collected or stored).
2. If the derived age indicates a minor (`age <= 18`, fail-closed through the boundary year) **and** the link's domain is guardian-gated, the form **stops before consent**: no consent checkboxes are shown, because there is nothing the minor can validly accept.
3. Submit proceeds **without** a consent block. Signals creates the account and profile in `draft` and returns `consent_outcome.state = 'u18_redirect_required'`.
4. The form shows a terminal "finish in the app" screen with a deep link to the Signals UI, explaining that a parent or guardian needs to confirm.
5. The Signals-side `consent_pending` nudge (U18 template) follows up.

Creation without consent is correct and already the established rule: creating a profile never requires consent — consent and age only gate **go-live** (07-24 design).

The aggregator must not attempt to derive minority itself for gating purposes beyond deciding what to render: whether a domain is guardian-gated is resolved server-side in Signals (`guardianConsentRequired`), and Signals' verdict is authoritative. The form's age check is a UX shortcut; `u18_redirect_required` is the control.

### 4.5 What the aggregator stores

`link_submissions` records which consent points were submitted and at which versions, as operational provenance for the aggregator's own dashboard and audit. The **Signals ledger remains the system of record** for participant consent. The aggregator does not mirror participant consent into `aggregator_consent_record`.

## 5. Testing

**Unit** — form-type → required-points resolution for both shapes; age derivation from birth year at the 18/19 boundary; consent-block validation (missing point, unknown point, version mismatch).

**API** — `account_and_profile` submit without `profile_creation` → `400 CONSENT_REQUIRED` and no Signals push; `account_only` submit with the consent block **accepted** (the #435 allow-list regression); stale version → `409`; happy path forwarding exactly the right `compliance` keys with `channel: 'link'`; minor on a gated domain → submitted with no consent block, profile created `draft`, `u18_redirect_required` surfaced, zero consent rows written, no OTP sent.

**Regression** — no code path sends `terms_accepted` / `privacy_accepted`; `consent_terms: true` is gone from `MinimalIdentityForm`; a declined checkbox blocks submit **server-side**, verified by posting directly to the endpoint with the client bypassed.

**UI** — consent checkboxes render for both form types with working Terms/Privacy modal links; copy is fetched from Signals, not bundled; minor path renders the redirect screen and never renders consent checkboxes; consistent across provider and seeker aggregator types (#522 Task 2 criterion).

## 6. Out of scope

- **Guardian consent on this form** — deliberately impossible (§4.4).
- **Re-consent on version bump for already-registered participants** — handled entirely on the Signals side (login gate + nudge); this form only captures at submit.
- **Bulk upload** — the operator-attestation spec.
- Mirroring participant consent into the aggregator ledger — explicitly rejected (§4.5).
