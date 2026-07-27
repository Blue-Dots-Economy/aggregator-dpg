# Bulk upload — operator attestation of authority (#522 Task 1)

**Issue:** [#522](https://github.com/Blue-Dots-Economy/aggregator-dpg/issues/522) — **Task 1** (bulk upload). Task 2 (form-mode registration consent) is covered by `2026-07-27-qr-registration-participant-consent-design.md`.
**Epic:** [#394](https://github.com/Blue-Dots-Economy/aggregator-dpg/issues/394) · Signals twin epic [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99)
**Date:** 2026-07-27
**Status:** Design — pending review.

**Extends:** `2026-07-02-registration-consent-design.md` — the versioned operator consent config and the `aggregator_consent_record` ledger, which explicitly scoped out bulk.
**Incorporates:** @AbhiGaddi's analysis in #522 (2026-07-27). This design agrees with its scoping and acceptance criteria; §3.1 and §3.6 record where it goes further, and §5 answers its open question on `presume_consent`.
**Related:** signals-dpg `2026-07-27-consent-external-channels-design.md` (the nudge that reaches bulk-onboarded participants) and `2026-07-27-consent-version-upgrades-design.md` (the `event` column this spec's provenance push depends on).

---

## 1. Scope

Confirmed in #522: **this is the aggregator's own consent, not the uploaded participants'.** Only a participant can consent for themselves; an aggregator uploading a roster cannot consent on their behalf, and recording it as participant consent would fabricate a legal basis.

The checkbox in the issue attachment reads:

> _"I have the permission from the users in the list to upload their details for Purple Dot creation."_

That is a statement **about the operator, made by the operator** — an assertion of authority to submit third-party data. This spec calls it an **attestation** to keep it terminologically distinct from participant consent, but it is the same thing #522 calls "the aggregator's consent" and it is recorded in the same operator ledger. It is also precisely the "onboarding/provenance note" that §4.5 of the cross-DPG consent design specified in place of a fabricated accept.

Two deliverables:

1. A **required, versioned operator attestation** captured per bulk upload and recorded server-side.
2. **Removal of the fabricated participant consent** bulk currently pushes to Signals.

## 2. Current state (verified)

- **No consent gate on bulk upload.** `apps/web/src/app/(protected)/onboarding/_components/CSVUpload.tsx` has no consent checkbox, and no upload endpoint requires one.
- **Bulk fabricates participant consent.** `apps/worker/src/jobs/bulk-row-process.ts:419-420` sends `terms_accepted` / `privacy_accepted` derived from `networkCfg.aggregator.onboarding.presume_consent` (`true` in all five deployed configs), with the in-code justification that aggregator registration consent is the legal basis for the push.
- **Those flags are dead.** Signals marks `terms_accepted` / `privacy_accepted` deprecated and **ignores** them (`packages/schemas/src/admin/participant.ts:16-18`), recording consent only via `compliance`. So they neither establish nor record anything — the push is misleading rather than merely wrong.
- **The ledger records registration only.** `aggregator_consent_record` is written once per registration; there is no per-upload event and no read path — `ConsentLedgerBase` exposes only `recordRegistrationConsent` (`packages/consent-ledger/src/interface.ts:101`).
- **`bulk_uploads` exists** (`packages/db-schema/src/schema.ts:255`) with `aggregatorId`, `uploadedBy`, `participantType`, `schemaId`/`schemaVersion` — a natural anchor for the attestation.

**The current net effect is accidentally correct.** Bulk-onboarded participants have zero consent rows, so Signals' go-live gate keeps their profiles `draft`. This spec makes that outcome deliberate and adds the operator record that was missing.

## 3. Design

### 3.1 Versioned attestation content

#522 proposes recording "terms/privacy version" for the upload, reusing `loadConsentConfig(network, brand)` as registration does. This design does that **and** versions the attestation statement itself — because the sentence the operator ticks is not the terms text, so recording only terms/privacy versions would not record what they actually attested to.

Extend the aggregator consent config with an `attestations` block per audience:

```jsonc
{
  "audiences": {
    "org": {
      "documents":    { "terms": { … }, "privacy": { … } },
      "attestations": {
        "bulk_upload": {
          "current_version": 1,
          "versions": [
            {
              "version": 1,
              "statement": "I have the permission from the users in the list to upload their details for Purple Dot creation.",
              "effective_from": "2026-08-01"
            }
          ]
        }
      }
    },
    "aggregator": { "…": "same shape" }
  }
}
```

`AggregatorConsentConfigSchema` gains `attestations` as an **optional** record of statement-documents, reusing the existing `DocSchema` invariants (`current_version` present in `versions`, unique version integers). Optional keeps the four existing `consent.json` files valid until authored.

A statement document carries `statement` where a content document carries `title` + `content` — mirroring Signals' existing `StatementVersion` / `ContentVersion` split.

> **Per-network authoring, not interpolation.** `2026-07-02` §5 established that consent content has **no runtime template substitution** — it is pre-authored with literal branding per network/brand file. The network name in the statement above ("Purple Dot") must therefore be written literally into each network's file. Flagged explicitly because a network name inline in the sentence is exactly the case that tempts a `{{network}}` placeholder.

### 3.2 Ledger extension

`aggregator_consent_record` gains:

| column                | type                                           | notes                                         |
| --------------------- | ---------------------------------------------- | --------------------------------------------- |
| `record_kind`         | `text NOT NULL DEFAULT 'registration_consent'` | `registration_consent` \| `attestation`       |
| `attestation_kind`    | `text NULL`                                    | `bulk_upload`; set only for attestation rows  |
| `attestation_version` | `integer NULL`                                 | version of the attestation statement accepted |
| `upload_id`           | `uuid NULL` → `bulk_uploads.id`                | the upload this attestation authorises        |

The default backfills existing rows to `registration_consent`, which is what they are.

`termsVersion` / `privacyVersion` become nullable but are **still populated on attestation rows** with the versions in force at upload time — that satisfies #522's acceptance criterion "who / when / terms+privacy version" while `attestation_version` records the statement actually shown.

A **check constraint** keeps both row kinds well-formed in one table: `registration_consent` requires both version columns; `attestation` requires `attestation_kind` + `attestation_version` + `upload_id`.

`subject_type` / `subject_id` continue to identify the acting operator (`org` or `aggregator`), so the attestation is attributable to whoever clicked Upload. `uploadedBy` on `bulk_uploads` records the individual user; the ledger records the accountable subject.

> **Ledger is the system of record.** #522 suggests the `bulk_uploads` row "and/or" a ledger row. Choose the ledger, with `upload_id` as the join: it is append-only and already the consent system of record, whereas `bulk_uploads` rows are operational and subject to retention/cleanup. Denormalising `attested_at` onto `bulk_uploads` is optional convenience, not the record.

### 3.3 Ledger interface — the first read path

```ts
abstract recordAttestation(
  input: RecordAttestationInput,
): Promise<Result<AttestationRecord, BaseError>>;

abstract getLatestAttestation(
  subjectType: 'org' | 'aggregator',
  subjectId: string,
  attestationKind: string,
): Promise<Result<AttestationRecord | null, BaseError>>;
```

`getLatestAttestation` is the aggregator's **first ledger read**. It serves this spec (showing "attested at v1 on <date>") and is the seam that later unblocks operator re-consent on a version bump — deferred by `2026-07-02` and still a no-Keycloak gap. Both return `Result` and never throw, per `.claude/rules/`. Implemented in all three: `PostgresConsentLedger`, `InMemoryConsentLedger`, and the `Fake` with `seed()`.

### 3.4 Upload flow

**UI** (`CSVUpload.tsx`). A required checkbox below the dropzone rendering the current attestation statement, with clickable Terms/Privacy links opening the existing read-only modal — **reusing the `ConsentCheckboxWidget` + modal pattern** from the registration forms, as #522 proposes. `Upload` stays disabled until ticked. The red state in the attachment is the post-submit-attempt invalid state; unticked-and-untouched is neutral.

**API.** The bulk-upload create endpoint accepts:

```jsonc
"attestation": { "kind": "bulk_upload", "version": 1, "accepted": true }
```

- Missing, or `accepted !== true` → `400 ATTESTATION_REQUIRED`. No `bulk_uploads` row, no rows enqueued. **This is the server-side gate** #522 requires — not just a client gate.
- `version` ≠ the current resolved version → `409 STALE_ATTESTATION_VERSION`, carrying the current statement so the client re-renders. Mirrors the `409 STALE_CONSENT_VERSION` guard in the Signals versioning spec, for the same reason: nobody should be recorded as accepting text they never saw.
- The recorded version is **server-resolved** from config, never taken from the body — matching how `recordAggregatorConsent` already resolves `termsVersion` / `privacyVersion` (`aggregator-registrations.ts:441`).

**Ordering — fail-closed.** The attestation row is written **before** any participant row is enqueued; a write failure aborts the upload. This mirrors the pattern documented in `apps/api/CLAUDE.md` — consent recorded before provisioning, so a consent-write failure rolls back cleanly and never leaves a subject without a record. Do not reorder.

Because the attestation and the `bulk_uploads` row are created in the same request, they are written in **one transaction**, with the ledger insert before the enqueue.

### 3.5 Stop fabricating participant consent

- Remove `terms_accepted` / `privacy_accepted` from the `ss.onboard(...)` call in `bulk-row-process.ts`.
- Participants continue to arrive at Signals with no consent → `draft` → not discoverable, now by design. They are prompted by the Signals-side #367 nudge.

### 3.6 Provenance to Signals

Bulk already sends `channel: 'bulk'` and `source_id: job.uploadId`. Add an authority block so Signals can record _who_ asserted the right to submit this data:

```jsonc
"onboarding_authority": {
  "attested_by_subject_type": "org",
  "attested_by_subject_id": "‹uuid›",
  "attestation_kind": "bulk_upload",
  "attestation_version": 1,
  "attested_at": "2026-08-04T…Z"
}
```

Signals records this as a **`provenance` event** on `consent_record` — never an `accepted` row. This needs the `event` column from the Signals versioning spec, so it is a **cross-repo dependency**: Signals ships first. Until then the field is accepted and ignored, which is additive and safe.

This goes beyond #522's acceptance criteria and is what turns "we removed the fake consent" into "we recorded the real basis". It implements §4.5 of the cross-DPG design.

## 4. `presume_consent` — the answer to #522's open question

> _"Decide + document interaction with `presume_consent` (does the flag still short-circuit for existing deployments?)"_

**No. `presume_consent` is retired entirely, not repurposed and not honoured as a bypass.**

Reasoning:

1. **It never did what its name claims.** Its only effect is setting two flags that Signals ignores. It has never established participant consent for anybody, in any deployment.
2. **It must not become an attestation bypass.** The attestation asserts _the operator's own authority_. No instance-level config flag can make that assertion on an operator's behalf — that is the whole point of requiring a person to tick it. A `presume_consent: true` short-circuit would reintroduce exactly the fabrication this ticket removes, one layer up.
3. **Nothing breaks for existing deployments.** Participants onboarded under the flag were already consentless and already `draft`; removing it changes no participant's state. The only behavioural change is that new uploads require a tick.

**Removal steps:** drop the key from all five `aggregator.config.yaml` files and from `aggregator.config.example.yaml`, and drop it from the config schema/type.

**Sequencing note:** the flag has a second reader, `public-registration-links.ts:556-557`, removed by the QR/form spec (#522 Task 2 / #475). The key cannot be dropped until both readers are gone — so either land that spec first or land both together. Until then, leave the key in place and unread rather than partially removing it.

**Not retro-attested.** Uploads already completed are not back-filled with an attestation; the ledger records what happened, and no operator ticked anything. Their participants remain `draft` pending their own consent.

## 5. Testing

**Unit** — attestation config parsing (absent `attestations` still valid; `current_version` not in `versions` rejected); the check constraint accepting both well-formed kinds and rejecting a mixed row; `getLatestAttestation` returning the highest-`seq` row, and `null` for a subject with none.

**API** — upload with no attestation → `400` with **zero** rows enqueued and no `bulk_uploads` row; stale version → `409` carrying the current statement; happy path writing exactly one attestation row before enqueue; a forced ledger-write failure aborting the whole upload (the fail-closed guarantee); a spoofed body version being ignored in favour of the server-resolved one.

**Regression** — bulk push no longer sends `terms_accepted` / `privacy_accepted`; a bulk-onboarded participant lands `draft` in Signals with zero consent rows.

**UI** — `Upload` disabled until ticked; statement rendered from config, not hardcoded; Terms/Privacy modal opens from the label links.

## 6. Out of scope

- **Participant consent on bulk.** Impossible by design. Bulk participants consent in Signals, prompted by the #367 nudge.
- **Re-attestation on version bump.** `getLatestAttestation` makes it possible; enforcing it is a no-Keycloak gap item. An operator who attested at v1 is not re-prompted at v2.
- **Per-row attestation.** One attestation covers one upload.
- **Converging the aggregator and Signals consent config schemas** — migration-issue item.
