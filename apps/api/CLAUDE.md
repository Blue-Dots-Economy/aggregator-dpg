# CLAUDE.md — apps/api

Guidance specific to working inside `apps/api`. Read the root `CLAUDE.md` first (product/architecture overview) — this file covers what's non-obvious once you're actually editing files here.

## Auth is consistent but per-file, not framework-enforced

There is no global Fastify `preHandler` hook wired at `app.ts` level. All verification logic lives in one shared module, `services/auth/access-token.ts` (`authenticate`, `requireApproved`, `authenticateAny`), but **each route file re-declares its own thin local wrapper** around it — e.g. `requireAuth()` in `bulk-uploads.ts:769`, `requireApprovedAuth()` + `requireAuth()` in `dashboard.ts:589,610`. Every handler in a file calls its wrapper as its first statement (verified across all route files — no handler currently skips it), so today's code is consistent. But **nothing prevents a new route from omitting the call** — the build succeeds either way. If you add a route file, copy an existing wrapper rather than inventing a new pattern, and call it first in every handler.

Service-account-only endpoints additionally gate on `subject.startsWith('service-account-')` (`aggregator-maintenance.ts:145`) — `authenticateAny` alone accepts both end-user and service-account tokens and doesn't distinguish privilege level. **That check is known-broken and tracked separately** (`sub` is a UUID for service accounts too, on every client, so the `startsWith` can never match) — do not copy it into a new route. The correct discriminator, established by the campaign non-PII dump route (#692, `campaign/auth.ts`), is a positive match on `preferred_username` (`service-account-<client>` for a service account vs. the human username for a password-grant token on the same client).

## Registration status has no documented state machine — here it is

`AggregatorStatus = 'pending' | 'active' | 'inactive' | 'retired'` (`packages/db-schema/src/schema-types.ts:17`) is a bare type union in code with no transition diagram anywhere. In practice:

- **Approve** (`pending → active`) is CAS-guarded: `aggregatorStore.approveFromPending()` (`services/aggregator-store/postgres.ts:189`) does `UPDATE ... WHERE id=? AND status='pending'` — a concurrent double-approve is a no-op on the second call, not a double-provision.
- **Reject** (`pending → inactive`) uses a plain `store.update(...)` write (no CAS) — safe because rejection has no provisioning side effects to double-fire; a `prior = decisionFromStatus(...)` read-then-check guard runs before either branch regardless. The reject write also stamps a **write-once `rejected_at`** timestamp (coordinator via the `update` patch, org via `casFromPending` on the `inactive` transition) — see the cooling window below.
- `retired` exists in the type but its transition path isn't in the approval routes above — check `aggregator-maintenance.ts` before assuming where it's set.

**Rejection cooling window (#726).** A rejected coordinator/org cannot re-register until `REGISTRATION_COOLING_MINUTES` (default `720` = 12h) has elapsed since `rejected_at`. The window is measured from the **write-once `rejected_at`**, never the mutable `updated_at` (any later write would move it — the race we designed around). On the public submit path (`aggregator-registrations.ts` email+phone, `aggregator-orgs.ts` owner_email) a rejected match within the window → `409 REGISTRATION_COOLING` with `error.fields.retry_after` (ISO); once elapsed the **same row is revived** to `pending` (`rejected_at` cleared) and the review link re-sent — the disabled Keycloak user/group stay intact, nothing is deleted or re-created. The shared verdict helper is `services/registration-cooling.ts` (`coolingRetryAfter`), imported by both routes so they can't drift. `rejected_at` is `NULL` for rows rejected before migration `0021`; the helper falls back to `updated_at` for those.

## Consent lives only in the ledger, written in the create transaction (migration 0029)

`consent_record` (was `aggregator_consent_record`) is the only home of consent: `users.consent` is gone, and the profile's `consent` is composed from the coordinator's newest `registration` / `registration-backfill` row (`given_at` = its `accepted_at`). Rows carry the permanent audit key (`subject_type` `user` | `organisation` + `subject_id`) and typed `user_id` / `org_id` links that drop to NULL when the subject is deleted; a trigger refuses every other UPDATE and every DELETE.

Registration is fail-closed in **one transaction**: `aggregatorConsentWriter()` (`routes/aggregator-registrations.ts`) and `orgConsentWriter()` (`routes/aggregator-orgs.ts`) read the consent config first, then hand `store.create()` a `recordConsent` hook that writes the ledger row **inside** the create transaction (through `getConsentLedger().withExecutor(tx)`). A ledger failure throws, so the contact, the account / org and the consent all roll back and the store answers `CONSENT_WRITE_FAILED`. Keycloak is provisioned only after that commit. **Do not move the ledger write out of the transaction or after provisioning** — that would let a subject exist without a consent record. Rows of subjects deleted later (a Keycloak failure, the stale prune) stay, unlinked. The profile PATCH refuses `consent` (400): consent is read-only after registration.

## Known gap: Keycloak calls have timeout but no retry — flagged, not fixed here

`.claude/rules/error-handling.md` requires "retry transient failures at least once with exponential backoff" on every external call. `services/idp-admin/keycloak.ts` (582 lines) routes every admin call through `safeFetch` (`:530`), which applies `AbortSignal.timeout(HTTP_TIMEOUT_MS)` uniformly — but **there is no retry loop anywhere in this file**. This is a real, verified deviation from the repo-wide rule, not a doc gap. If you're touching this file for an unrelated reason, don't assume retry exists; if you're adding retry, be aware Keycloak admin calls (user enable, role assign) are not all naturally idempotent — check each call site's side effects before wrapping it in a blind retry.

## Accounts live in `users` (migration 0027)

`aggregators` was renamed `users` (ids kept: the Keycloak `aggregator_id` attribute, the token claim and the Signals `external_id` still point at the same rows). Things that are easy to get wrong:

- **Two account types share the table.** `user_type = 'coordinator'` rows are coordinators (registration state + their own Signals org: `signalstack_org_slug` / `signalstack_org_name` / `signalstack_org_id`). `user_type = 'admin'` rows are org owners and hold **identity only** — every coordinator column is NULL (`users_role_shape_chk`). The column defaults (`status`, `profile`) remain for coordinator inserts, so an admin insert must write explicit NULLs — use `db/account-writes.ts` `linkAdminAccount`, never a hand-written insert.
- **The aggregator store sees coordinators only.** Every read AND write in `services/aggregator-store/postgres.ts` goes through `coordinator(...)` (`user_type = 'coordinator'`). An admin id must never resolve as an aggregator — keep that filter on any new query.
- **An org's owner is `organisations.org_owner`** (an admin account; one per person, shared by every org they own; `owner_user_id` before 0028). Deleting an org releases the owner's account once it owns nothing else — a database trigger (`organisations_owner_ad`), whatever path deletes the org. A Keycloak owner user is deleted by the stale prune only when the owner has no other org (`orgStore.ownerIsShared`).
- **IdP logins are provider-neutral** — `user_identities (user_id, provider, subject)`, provider `IDP_PROVIDER` (`services/idp-admin/provider.ts`). Recorded once, never overwritten (`MISMATCH`), one account per external login (`DUPLICATE`). Coordinators' logins are recorded lazily (review link, first approved request) via `services/identity-store/record.ts`.
- **Coordinator columns since 0029:** `serves text[]` (network domain ids; `'{}'` = every domain; the domain object's `type` is its first entry, and `actor_type` is always `'aggregator'`), `alternate_phone` (the Beckn `contact.alternatePhone`), `invite_id` (the consumed invite; the invited address is read through it, else `profile.legacy_invite_email`). Admin rows have `serves = '{}'` and NULL for the others (`users_role_shape_chk`).
- **Drizzle names follow the columns** (0029): `users.signalstackOrgSlug` / `signalstackOrgName`, tenant tables' `userId`, `onboarding.signalstackOrgSlug`, `campaignPiiAudit.actorSignalstackOrgId`, `registrationStatusEnum`; the `aggregators` / `aggregatorOrgs` aliases are gone. The domain objects, the session and the queue payloads keep `aggregatorId` (the token claim is renamed in Phase 5), and the store directories keep their names until then.
- **Migrations at boot are guarded** (`db/migration-guards.ts`): `runMigrations()` refuses an applied migration that is not in the journal, and refuses to apply the user & org release train (0023 onwards) at boot on a database that holds data — existing instances migrate with the release-train tool (`src/tools/train.ts`, run from the API image; `docs/user-org-migration-runbook.md`). Dev / e2e databases can set `ALLOW_TRAIN_ON_BOOT=true`; never a deployment.
- **The release-train tool** (`src/tools/train.ts`, `node dist/tools/train.js check | run | enrich`): takes a database from exactly 0022 to the latest migration in **one transaction** that applies every migration (`db/migrate-core.ts` `applyPending`, which writes the same `__drizzle_migrations` rows drizzle does) and runs every verify gate, committing only when all are 0. `check` / `run` are **config-free** (no `config.ts` import; only `DATABASE_URL` + `AGGREGATOR_NETWORK`); only `enrich` (`train-online.ts`, loaded lazily) needs the full API env. The operator SQL lives in `scripts/sql/` (`train-check.sql`, `*-verify.sql` with a `category` column, `fixes/`) and is copied into the image at `/app/sql`. It never prints row data — keep it that way.

## Person contacts live in `contact` (migrations 0025 / 0026)

A coordinator's and an org owner's name / email / phone are stored once, in `contact`, and referenced by `users.contact_id` (since 0027 an org owner is an admin `users` row; every FK to `contact` is named `contact_id`; a second one in the same table would take a role prefix). The stores compose the Beckn `contact` the API has always returned (`contact` row + `users.alternate_phone` for `alternatePhone`, and the org's `legal_name` / `gst_number` for `company` / `gstNumber` since 0028), in the legacy jsonb key order, so responses are byte-identical to before. Things that are easy to get wrong:

- **`contact.id` is PII.** It is `sha256(lower(email):phone)` (`contactId()` in `@aggregator-dpg/shared-primitives/contact`, `contact_id_of()` in SQL — golden vectors pin them together). Never log it or put it in a URL.
- **One person per email and per phone, across coordinators AND org owners** (`contact_email_unique`, `contact_phone_unique`). The phone is the OTP login key. Org create pre-checks this (`PHONE_EXISTS` / `OWNER_ALREADY_REGISTERED`) and profile PATCH too (`PHONE_EXISTS` / `USER_EXISTS`), both before touching Keycloak; the unique indexes are the backstop.
- **Write through `db/contact-writes.ts`, inside the store's transaction.** Changing an email or phone re-keys the row in place (FKs are `ON UPDATE CASCADE`). It is refused when the contact is shared by two roles (`SharedContactError` → 409 `CONFLICT`) or when the new email + phone already form another person's contact (`ContactTakenError` → `USER_EXISTS`); rows are never merged.
- **Orphan contacts are collected by the database** (`contact_gc()` from the `users` `AFTER DELETE` trigger; an org delete releases its owner's account first) — do not add app-side deletes.
- **Store errors never echo the driver message**: Drizzle puts the query parameters (emails, phones) in it. Log the SQLSTATE and constraint name instead.
- **Existing instances run a pre-flight before deploying** — `docs/contact-migration-runbook.md` (stop-the-world; `scripts/contact-migrate.sh preflight | dry-run | apply | verify`). 0025 is also the pre-deploy script, so it must stay idempotent.
- **A new migration's journal `when` must exceed every earlier entry's.** The migrator skips by that high-water mark, not by hash, so a smaller `when` is silently never applied. `runMigrations()` holds an advisory lock, so replicas booting together are safe.

## Organisations (migration 0028)

`aggregator_orgs` was renamed `organisations` (ids kept) and the hierarchy flag is gone: the org routes are always registered. Things that are easy to get wrong:

- **One root, one Default.** Exactly one `org_type = 'network_facilitator'` org (the root, `parent_id` NULL); every other org is `aggregator` under it. The fixed **Default** org (`slug = 'default'`, `DEFAULT_ORG_SLUG`) holds coordinators that had no org. Both are owned by admin accounts reconciled at boot by `services/organisation-root.ts` (`ensureRootOrganisation()`: root owner = first `ADMIN_EMAILS`, Default owner = `DEFAULT_ORG_OWNER_EMAIL` else the root's; also mirrors both orgs and configured owners into Keycloak, soft-failing). The migration seeds placeholders (`network`, `network-admin@nf.invalid`).
- **The org store sees aggregator orgs only.** Every read and write in `services/aggregator-org-store/postgres.ts` goes through `scoped()` (`org_type = 'aggregator'`); only `findRoot()` returns the root. Owner lookups (`findByOwnerEmail` / `findByOwnerPhone`) also skip the Default org — the network admin owns it and must not read as "already an org owner". The store keeps its old name and `displayName` field until Phase 5.
- **Every coordinator has an org** (`users.org_id`, required by `users_role_shape_chk`); `Aggregator.parentOrgId` is that id, Default included, and `isDefaultOrg` says which. Coordinator registration requires `org_id` or an invite (for one release a body without either is placed in Default with a warning). The Default org is selectable only while it is the only active org (`GET /v1/orgs` hides it otherwise); a Default registration names its own organisation (never "Default").
- **Approval tokens always carry the org claim**, Default included; the decision path rejects a mismatch. Links minted before 0028 for formerly-flat coordinators have no claim and are rejected — regenerate binds the fresh token to the coordinator's current org (and accepts an org-less legacy link only for a Default coordinator; it never re-binds a link minted for another org). Default-org reviews go to `DEFAULT_ORG_OWNER_EMAIL`, else `ADMIN_EMAILS`.
- **Org details belong to the org.** `url`, `locations`, `contact.company` and `contact.gstNumber` are rendered from the coordinator's org (`organisations.url` / `locations` / `legal_name` / `gst_number`), falling back per field to the coordinator's own values in `users.legacy_org_details` (`services/aggregator-store/org-details.ts`). Profile PATCH of any of them → `409 ORG_DETAILS_READ_ONLY`; coordinator registration ignores them for a real org and keeps them as `legacy_org_details` for Default. Org create maps `website` / `address` / `coordinates` to `url` / `locations` (`services/org-location.ts`).
- **Tenant rows carry `org_id`** (the user's org at insert time), filled by a `BEFORE INSERT` trigger (`tenant_set_org_id`) — inserts never pass it.

## Bulk-upload: the API only validates, reserves, and enqueues

Streaming CSV parsing is entirely `apps/worker`'s job (see `apps/worker/CLAUDE.md`). The API side (`routes/bulk-uploads.ts`) does: presigned S3 PUT → `/start` validates the object exists via `headObject` (size-0 check + `BULK_UPLOAD_MAX_BYTES` as belt-and-braces, since a presigned PUT can't itself cap size) → `store.markUploaded` → `enqueueBulkFileProcess` (`services/bulk-queue/index.ts`, `jobId = uploadId` for idempotent enqueue — a retry of `/start` can't double-enqueue). If enqueue fails after `markUploaded` succeeds, the row is left `uploaded` with no active job — recovery relies on the worker's stuck-job watchdog (`cron-watchdog.ts`, see `apps/worker/CLAUDE.md`), not a retry here.

## Health probes & observability

`/health/live` is a static liveness probe (no dependencies). `/health/ready` probes Postgres (`select 1`) + Redis (`ping`) with a 2s per-dependency timeout, returning `503` and naming the failing dependency otherwise. On `SIGTERM` the shutdown path drains Fastify and the PG pool, then `Promise.allSettled` closes the rate-limiter, Redis, and the bulk queue — **do not add a long-lived connection without also closing it here**, or shutdown will leak it.

`signalstack-writer` forwards an optional `requestId` as the `x-request-id` header from request-scoped call sites (dashboard, public-lookup, registration-links, approvals) so a trace correlates across services. The worker `onboard`/login-backfill paths have no request context and don't propagate it (known follow-up).

A Signals `409 PROFILE_LIMIT_REACHED` is mapped to `SIGNALSTACK_PROFILE_LIMIT_REACHED` and categorised as `limit_reached` (not `system_error`) in `errors.csv`, and surfaced on registration links. Note that `onboard` is **no longer idempotent** — it always inserts, bounded only by the profile cap.

## Public registration submit — two things that are not obvious from the route

**`item_locations` is transport metadata, not a profile field (#778).** The submit body may carry `item_locations` — the coordinates the registrant picked from the address autocomplete. `public-registration-links.ts` reads it and then **deletes it from the body**, exactly like the consent and birth-year keys, so it never reaches Ajv or the signalstack `item_state`. It is validated locally (strict numbers, lat/lng bounds, max 25 entries) rather than forwarded blind: signals would answer with its own 400 that this route cannot attribute back to the offending key. Absent or empty means no suggestion was chosen — or no Maps key is configured — and signals geocodes the address text instead, which is the behaviour that predates the field.

**The local `participants` mirror is gone (#780, then migration 0024).** It deduped per phone and used to report `skipped`, which after the client-side gate came down meant a participant was told "already registered" while a second profile had just been created upstream — it pushed to Signals regardless of its own UPSERT result, so the local verdict was simply wrong. #780 stopped it deciding the outcome; 0024 removed the table. Signals is the identity authority; the route skips **only** when the identity is genuinely owned by ANOTHER aggregator — tenant isolation, not deduplication, and sourced from Signals' `owned_elsewhere`, never from a local row. The `link_submissions` row is still inserted before the push and corrected in the same transaction, so a submission that created a profile is never recorded as a duplicate.

**There is no deduplication on either onboarding path.** Verified empirically: two identical public-link submissions both return 201 `passed` and produce two distinct Signals profiles. This is consistent with the `onboard` note above — it always inserts. If dedup is wanted it belongs in Signals, where the identity actually lives; a per-aggregator table cannot see other aggregators anyway.

**Brand `attribution` on `/v1/aggregator-config` is opt-in (signals-dpg#720).** The response only carries an `attribution` array when the resolved `brand.json` declares one, so every deployment that does not is byte-identical to before.

## Campaign PII audit log (#617)

`campaign_pii_audit` is **append-only** and records every campaign action that
**releases data** — export, voice, email, and the non-PII dump. Status/list GETs
are deliberately NOT audited: the rule is data release, not API traffic, and
clients poll every 5-10s.

- A campaign writes **two** rows sharing `correlation_id = campaign_job.id`:
  `requested` from the API, `completed` from the worker on terminal status.
  A dump writes **one**. That row's `actor_signalstack_org_id` (`actor_org_id`
  before 0029) is never set at all —
  `DumpAuditInput` (`packages/campaign-audit/src/interface.ts`) has no such
  field, and `PostgresCampaignAuditWriter.recordDumpAccess` (`postgres.ts`)
  omits the key from the insert rather than passing an explicit `null` — the
  column stores NULL as a result. That NULL is meaningful: it marks a
  whole-network, un-org-scoped access, and must never be backfilled with a
  guessed org.
- `event` is the phase, `outcome` is the result. `outcome` is NULL on
  `requested` rows.
- `piiFields` (on the `requested` row) carries **field NAMES and counts
  only, never values** — see the interface's module doc
  (`packages/campaign-audit/src/interface.ts:8-9`). The voice channel is the
  one place this needed active enforcement: `content.variables` is
  caller-supplied free text (not a schema-validated field-name list), so
  before it is copied into `piiFields` it passes through
  `apps/api/src/campaign/audit-field-names.ts`'s
  `sanitizeAuditFieldNames`/`auditFieldNameEntries`, which keeps only
  identifier-shaped strings, each at most `MAX_FIELD_NAME_LENGTH` (64) chars,
  and at most `MAX_FIELD_NAME_COUNT` (50) of them per row, replacing whatever
  it drops with a count — `+N redacted (non-identifier)` for shape failures,
  `+N redacted (too long)` for an over-length entry, `+N redacted (over
limit)` once the count cap is reached — three distinct markers, never
  folded together, so each count means what it says and never the raw value
  itself. Known residual gap: a single-word ASCII value up to 64 characters
  (e.g. a first name with no space) is indistinguishable from a real field
  name by that filter and passes through unredacted; don't rely on it to
  catch that case.
- The writer (`@aggregator-dpg/campaign-audit`) is **write-only** — no update,
  delete or read. That absence IS the append-only guarantee; do not add one.
- Writes are **best effort**: they happen after the operation is already durable
  and never fail a campaign.
- The `completed` row carries the four outcome-count columns
  (`resolved_count`, `skipped_count`, `failed_count`, `sent_count`), plus
  (export channel only) `recipient_ref` and `destination`. All are populated
  at every point that writes a `completed` row — the worker's success
  roll-up and final-attempt-failure paths (`campaign-process/index.ts`), and
  the watchdog's stalled-job sweep (`jobs/cron-watchdog.ts`, see below) —
  from `rollUpStatus`/`countItems`'s item-status tally
  (`services/campaign-job-client.ts`), never re-queried separately.
  `toAuditCounts()` (same file) does the mapping:
  - **`resolved_count` ← `resolved + submitted`.** Voice items terminate at
    `submitted`, never `resolved` or `sent` — handing a contact to Raya IS
    the release, so it must be counted. Without this, a fully successful
    voice campaign would audit as `outcome: 'succeeded'` with every count at
    zero, which reads as "measured, and nothing happened" rather than "not
    measured" — worse than leaving the columns null. This mirrors
    `deriveJobStatus`'s own `succeeded = resolved + submitted + sent`
    grouping, so the counts and the derived status agree about what counts
    as a release. `sent_count` stays strictly confirmed-delivered (export/
    email's own success write).
  - **`skipped_count` aggregates three item statuses that are deliberate
    no-ops rather than a release** — `skipped_not_owned`,
    `skipped_no_contact`, and `duplicate_active` — never split across the
    fixed audit columns.
    `recipient_ref`/`destination` are an OPERATOR address and the deterministic
    S3 export key respectively (`resolveExportRecipient`/`exportObjectKey`,
    `campaign-process/index.ts`) — both helpers are shared between the send
    path and the audit write so the two cannot drift, and both are left unset
    for voice/email (an operator address must never be attributed to a channel
    that never released one).
- **`error_code` is dual-purpose — not a stable enumeration.** Depending on
  which code path wrote the row it holds either a genuine error code (the
  dump route's `503 DUMP_NOT_CONFIGURED`, or the watchdog's `stalled` below)
  or a raw exception class name (`err.constructor.name`,
  `campaign-process/index.ts`'s worker-completion write) — usually the
  literal string `Error`, since most thrown errors in this codebase are
  plain `Error`s rather than a named subclass. Renaming the column (e.g. to
  `error_class`) was considered and rejected: dump rows carry a real error
  code, so that name would be wrong for every one of those. Query this
  column expecting free text, not a fixed set of values.
- **The stalled-job watchdog also writes a `completed` row** (#617
  follow-up): `jobs/cron-watchdog.ts`'s stall sweep force-fails a
  `processing` job whose heartbeat went stale, which is a terminal
  transition per §6 of the design doc — the worker may have died mid-run
  after already releasing data to some participants, which is exactly the
  case with the least room for a missing completion record. That row has
  `outcome: 'failed'`, `error_code: 'stalled'`, and the counts above, plus
  (export channel only) `destination` and `recipient_ref` — the sweep's
  `.returning()` also selects `requested_by` (alongside `channel`/
  `signalstack_org_id`), so it recomputes `recipient_ref` with the exact same
  `resolveExportRecipient` helper a normal export completion uses, against
  the worker's own export-recipient config. Still an operator address, never
  a participant's.

Find gaps (audit rows that should exist and do not):

```sql
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'requested'
WHERE a.id IS NULL;
```

The mirror check (every `completed` has a `requested`) must exclude
`channel = 'dump'`, which legitimately has no `requested` row.

The reverse gap — a job that reached a terminal status but never got its
`completed` row — is exactly the anomaly the watchdog fix above closes;
`campaign_job` never has `channel = 'dump'` rows, so no exclusion is needed
here:

```sql
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'completed'
WHERE j.status IN ('completed', 'partial', 'failed')
  AND a.id IS NULL;
```

## Tests

Mixed convention within this app: most route/service files have a sibling `*.test.ts` (e.g. `aggregator-approvals.test.ts`), but several service subpackages use a `__tests__/` folder instead (`services/idp-admin/__tests__/`, `services/aggregator-store/__tests__/`). Either is fine here; match whichever convention the file you're touching already uses. One `.integration.test.ts` exists (`services/idp-admin/keycloak.integration.test.ts`), excluded from `pnpm -w test` per the repo-wide rule.
