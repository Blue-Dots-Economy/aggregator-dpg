# Non-PII dump download API — design

**Issue:** Blue-Dots-Economy/aggregator-dpg#692
**Umbrella:** Blue-Dots-Economy/signals-dpg#237
**Siblings:** #579 (export), #578 (email), #577 (voice)
**Produces the data:** Blue-Dots-Economy/signals-dpg#480 → Blue-Dots-Economy/adhoc-scripts#3
**Base branch:** `feature` (post-#602)
**Date:** 2026-08-26

## Purpose

The campaign manager (external, operated by EkStep) imports a non-PII snapshot of
Signals data — `user`, `items`, `item_actions` — to drive audience selection. It
currently reads those objects from S3 with its own IAM credentials. **That access
is being revoked.** This endpoint replaces it: the campaign manager asks the
aggregator for the dump, and the aggregator returns short-lived pre-signed URLs.
No S3 credential leaves our boundary.

Revoking the campaign manager's direct S3 IAM access is the point of the work. If
that revocation does not happen, this endpoint is decorative.

## What makes this endpoint different

`/v1/campaign/{export,email,voice}` are called by a **coordinator** — a human at
an aggregator. Their token carries `signalstack_org_id`, and every one of those
routes is scoped to it: a coordinator can only touch participants their own
organisation onboarded.

This endpoint has **no coordinator and no organisation**. The campaign manager
calls it machine-to-machine and receives the whole dump, every aggregator's rows.
signals-dpg#480 records that as an accepted risk, mitigated by the exporter's
column allowlist: the dump contains zero PII.

Org scoping — the control that makes the other three routes safe — does not exist
here. **The client identity is the only control.** The auth design is therefore
the load-bearing part of this work, not a detail.

## Upstream reality: there is no manifest

Issue #692 specifies resolving the latest run through `latest_manifest.json`,
written last so a consumer can never observe a half-written run. **The exporter no
longer writes one.** Commits `e153c43` then `d5e4a2d` on
`adhoc-scripts` `feat/signals-s3-export` (its own PR #7) deliberately replaced the
dated-run layout with three fixed keys, overwritten in place:

```
s3://<bucket>/[<prefix>/]<network>/<instance_id>/
├── user.ndjson.gz
├── items.ndjson.gz
└── item_actions.ndjson.gz
```

`lib/s3.py`'s docstring is explicit: _"no date/run folders, no manifest; consumers
always read the same keys."_ The job only ever PUTs, so its IAM role needs just
`s3:PutObject`. PR #3's description is stale relative to its own code.

Consequences, all of which shrink the work:

- No `run_id` and no `generated_at` — nothing to source them from.
- No manifest to fetch, so no `getObjectText` and no Zod manifest schema.
- The freshness signal is S3 object metadata: `LastModified` and `ContentLength`.

### Accepted risk: cross-table skew

Per-object PUTs are atomic, but nothing couples the three. A run takes tens of
seconds, so a caller landing mid-run can receive `user` from the new run and
`items` from the previous one — a torn snapshot in which a participant appears
without their items. There is no complete older copy to fall back to, because the
previous objects were overwritten.

**Decision: serve the three keys as they are.** The response carries each file's
`last_modified` and `size_bytes`, and the campaign manager decides what to do
about a mismatch. Rejected alternatives:

- _Detect and refuse_ — compare the three `LastModified` values and 503 when they
  span more than a threshold. Turns a silent data problem into a loud one, but it
  is a heuristic, not a guarantee.
- _Fix it upstream_ — ask adhoc-scripts to restore the run folders and pointer.
  The only true guarantee, but it blocks this work on another repo and reverses a
  decision that repo made deliberately.

This means #692's acceptance criterion "a run in progress is never served" is
**not met**, knowingly. History is likewise unavailable: the campaign manager
always wants the latest data, and serving a past run would first require enabling
S3 versioning on the bucket.

## Auth

### Verified token shapes

Both grant types were exercised against a local realm and their claims decoded:

| claim                   | `client_credentials` (system)      | `password` (coordinator) |
| ----------------------- | ---------------------------------- | ------------------------ |
| `azp`                   | `campaign-manager`                 | `campaign-manager`       |
| `preferred_username`    | `service-account-campaign-manager` | the coordinator's email  |
| `sub`                   | UUID                               | UUID                     |
| `sid` / `session_state` | absent                             | present                  |
| `email`                 | absent                             | present                  |
| `aggregator_id`         | absent when correctly provisioned  | present                  |
| `signalstack_org_id`    | absent when correctly provisioned  | present                  |

Two findings from this:

1. **`sub` is a UUID for service accounts too.** `apps/api/src/routes/aggregator-maintenance.ts:145`
   gates `/cleanup-stale` on `auth.context.subject.startsWith('service-account-')`
   with a comment asserting service accounts have a `service-account-<client>`
   subject. They do not — that is `preferred_username`. The check can never pass,
   so `/cleanup-stale` is permanently 403 and the scheduler's cleanup has never
   run. It fails closed, so it is not a security hole. **Filed separately; this
   design must not copy that pattern.**
2. **Absence of `aggregator_id` is not a safe discriminator.** It is a Keycloak
   _user attribute_. If someone sets it on the service-account user — as the
   current local realm has — the system token becomes indistinguishable from a
   coordinator token by that claim, and additionally satisfies
   `requireCampaignAuth` + `requireOrgId`, reaching the PII export. The security
   of the endpoint must not depend on the absence of a claim that is editable
   from the Keycloak admin console in another repo, invisible to any test here.

### Decision: one client, two grant types, gated on `preferred_username`

No new Keycloak client. The existing `campaign-manager` client serves both
identities via different grants:

- `grant_type=client_credentials` → the system token, for this endpoint.
- `grant_type=password` → a coordinator token, for the org-scoped routes.

Consequently **`CAMPAIGN_DUMP_ALLOWED_AZP` is not needed** — same client, same
`azp`, so the new helper reuses `campaignManagerAllowedAzp()`.

Rejected alternative: a separate `campaign-manager-system` client, which would
make the separation structural rather than a string comparison. Not taken —
it costs a second client for bluedots-automation to provision and a second
credential for an external party to rotate. The string comparison below is
chosen deliberately, with both directions covered by tests.

The gate is a **positive** check on `preferred_username`, not an inference from an
absent claim. Keycloak sets it to `service-account-<client-id>` for the service
account, and realm usernames are unique, so no human can hold that value —
regardless of what user attributes exist.

Request chain on the dump route:

1. `Authorization: Bearer …` present → else **401**
2. JWT verified against the realm JWKS — signature, issuer, expiry, and audience
   when `KEYCLOAK_EXPECTED_AUDIENCE` is set. Verification is offline against the
   cached key set; Keycloak is not called per request. → else **401**
3. `azp` ∈ `campaignManagerAllowedAzp()` (default `campaign-manager`) → else **403**
4. `preferred_username` === `CAMPAIGN_DUMP_SERVICE_ACCOUNT` → else **403**
5. HEAD the three keys, mint three pre-signed URLs, respond.

Steps 3 and 4 are both load-bearing: 3 establishes "you are the campaign
manager", 4 establishes "you are its server, not a coordinator logged in through
it".

**Dependency to be aware of:** `preferred_username` arrives via the `profile`
client scope. Removing `profile` from the client's default scopes would drop the
claim and the gate would 403 everything. That is the safe direction, but it would
present as a mysterious outage, so `realm.json` pins `profile` and this document
records the coupling.

### Changes required

`apps/api/src/services/auth/access-token.ts` — two additive changes.
`authenticate()` cannot be used here because it _requires_ an `aggregator_id`
claim, which a correctly-provisioned service account does not have.
`authenticateAny()` handles such tokens but accepts no `azp` override.

- `authenticateAny(req, opts?: { allowedAzp?: readonly string[] })`, mirroring
  the signature `authenticate` already has and passing through to `verifyToken`.
  The one existing caller passes nothing and keeps the global list, so its
  behaviour is unchanged.
- `AnyAuthContext` gains `preferredUsername?: string`.

`apps/api/src/campaign/auth.ts` — alongside `requireCampaignAuth`:

```
requireCampaignSystemAuth(req):
  authenticateAny(req, { allowedAzp: campaignManagerAllowedAzp() })   → 401 on failure
  preferredUsername === CAMPAIGN_DUMP_SERVICE_ACCOUNT ?               → else 403
  return { subject, azp, username }                                    // for the audit line
```

`CAMPAIGN_DUMP_SERVICE_ACCOUNT` fails closed the way `campaignManagerAllowedAzp()`
does: an empty or whitespace-only env value falls back to the default rather than
disabling the check, so a bad deploy value cannot open the gate.

**The reverse direction.** `requireCampaignAuth` gains one check: reject when
`preferredUsername` equals `CAMPAIGN_DUMP_SERVICE_ACCOUNT` → 403. With a correctly
provisioned service account this is redundant, because the missing `aggregator_id`
already 403s. It earns its place by covering the misprovisioned case, and it makes
"a system token cannot reach the PII routes" a property of this repo's code rather
than of Keycloak's user table.

## API

Read-only, so `GET`. No `/latest` segment — there is no history to distinguish it
from. The endpoint never streams data through the aggregator; it is an
authorisation gate that returns short-lived links.

```
GET /v1/campaign/dump
Authorization: Bearer <client_credentials token>

200 {
  "network":    "blue_dot",
  "instance":   "blue_dot_up",
  "expires_at": "2026-08-26T00:46:12.000Z",
  "files": [
    { "table": "user",
      "key": "blue_dot/blue_dot_up/user.ndjson.gz",
      "size_bytes": 12345,
      "last_modified": "2026-08-26T00:30:58.000Z",
      "url": "https://…" },
    { "table": "items",
      "key": "blue_dot/blue_dot_up/items.ndjson.gz",
      "size_bytes": 23456,
      "last_modified": "2026-08-26T00:31:04.000Z",
      "url": "https://…" },
    { "table": "item_actions",
      "key": "blue_dot/blue_dot_up/item_actions.ndjson.gz",
      "size_bytes": 34567,
      "last_modified": "2026-08-26T00:31:12.000Z",
      "url": "https://…" }
  ]
}
```

`files` is always the three tables in the order `user`, `items`, `item_actions`,
each with its own pre-signed URL. `expires_at` is the shared URL expiry — all
three are minted in one request. `last_modified` and `size_bytes` come from the
HEAD on each key and are the whole of the skew contract: they are how the campaign
manager sees whether the three files line up.

### Errors

| status | code                       | when                                                        |
| ------ | -------------------------- | ----------------------------------------------------------- |
| 401    | `UNAUTHORIZED`             | no token, bad signature, expired                            |
| 403    | `FORBIDDEN`                | `azp` not allow-listed, or not the service-account username |
| 404    | `DUMP_NOT_AVAILABLE`       | any of the three objects missing; `fields` names which      |
| 503    | `DUMP_NOT_CONFIGURED`      | `CAMPAIGN_DUMP_INSTANCE_ID` unset                           |
| 503    | `DUMP_STORAGE_UNAVAILABLE` | S3 HEAD or presign threw                                    |

`DUMP_NOT_AVAILABLE`, `DUMP_NOT_CONFIGURED` and `DUMP_STORAGE_UNAVAILABLE` are new
rows in `apps/api/src/errors/codes.ts`. The two 503s are distinct codes because
they have distinct fixes.

**All three files or none.** If one object is missing the route returns 404; it
never returns a short `files` array. A two-file response would read as success and
the campaign manager would silently import an incomplete picture.

No 429 from this route. Rate limiting is Kong's responsibility platform-wide, so
the sibling routes' in-code `consume()` call is deliberately not reproduced here.
The accepted consequence: a caller reaching the API directly, bypassing Kong,
faces no limit. The audit log below is the compensating control.

## Configuration

New vars in `apps/api/src/config.ts`, mirrored into **both** `apps/api/.env.example`
and `infra/env.template` with a comment explaining why — the existing campaign
vars there set that standard.

| var                             | default                            | notes                                                              |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `CAMPAIGN_DUMP_SERVICE_ACCOUNT` | `service-account-campaign-manager` | the gate; empty value falls back to the default, never disables    |
| `CAMPAIGN_DUMP_URL_TTL_SECONDS` | `600`                              | 10 minutes; a machine caller downloads immediately                 |
| `CAMPAIGN_DUMP_PREFIX`          | _(empty)_                          | optional containing prefix; empty means keys start at `<network>/` |
| `CAMPAIGN_DUMP_INSTANCE_ID`     | _(none)_                           | the Signals instance folder                                        |

The bucket is the existing `S3_BUCKET`. One bucket everywhere: the cron repoints
to the aggregator's bucket (being made private in bluedots-automation#163) with
its layout unchanged, so no `CAMPAIGN_DUMP_BUCKET` knob is introduced.

The network segment comes from `getNetworkConfig().network.id` rather than a fifth
env var, so it cannot drift from what the deployment actually serves. The key root
is `[<prefix>/]<network>/<instance_id>`.

**No fallbacks and no runtime probing.** A wrong prefix or instance id yields a
404 naming the missing keys, never a silently different dataset.

`CAMPAIGN_DUMP_INSTANCE_ID` has no sensible default, and the whole API must not
refuse to boot over a campaign var on deployments that do not use the campaign
manager. It is therefore optional in the schema; the route returns 503
`DUMP_NOT_CONFIGURED` when it is absent.

## Object storage

`apps/api/src/services/object-storage/index.ts` today exposes
`signBulkUploadUrl`, `headObject`, `putObject` and `signErrorsCsvDownloadUrl`.
Two additive changes:

- **`signDownloadUrl(key, { ttlSeconds, contentType?, contentDisposition? })`** —
  the generic presigner. It signs against the `S3_PUBLIC_ENDPOINT` client, which
  is correct here: the campaign manager is outside the cluster.
- **`ObjectHead` gains `lastModified`.** `headObject` already issues the HEAD and
  returns etag and length; it currently discards `LastModified`. Existing callers
  are unaffected.

`getObjectText` is **not** required — there is no manifest to read.

`signErrorsCsvDownloadUrl` is left alone. It duplicates the presign-and-compute-expiry
shape, but it is now the only such copy (`signQrDownloadUrl` was removed in #650),
so consolidating it is not worth widening this diff.

## Route

`apps/api/src/routes/campaign-dump.ts`, registered in `app.ts` next to
`registerCampaignExportRoutes` / `registerCampaignEmailRoutes` /
`registerCampaignJobRoutes`. Flow: auth → resolve key root → HEAD three keys →
presign three keys → audit log → respond. OpenAPI `tags: ['campaign']`, a summary,
and `errorResponses(401, 403, 404, 503)`, consistent with the sibling routes.

## Audit

One structured log line per call via the `@aggregator-dpg/observability` logger,
carrying the fields `.claude/rules/logging-observability.md` requires —
`operation` (`campaignDump.serve`), `status`, `latency_ms` — plus `azp`, subject,
username, network, instance, the three keys with each one's `last_modified`, the
TTL applied, and the request id. No PII is involved: by construction the dump
contains none, and the response carries object metadata only.

This is a whole-network read with no org scoping and no in-code rate limit, so
this line is the only trail it leaves. When #617 lands it becomes an audit-log
entry.

The two S3 calls are external calls and fall under
`.claude/rules/error-handling.md`: an explicit timeout on each, the SDK's standard
retry mode for transient failures, and a typed failure surfaced as
`DUMP_STORAGE_UNAVAILABLE` rather than a raw SDK error string. A missing object is
not a transport failure — `headObject` already returns `null` for `NotFound` /
`NoSuchKey`, which is what drives the 404.

## Testing

The auth matrix is the specification, not an extra:

| token                                                   | route                 | expected                |
| ------------------------------------------------------- | --------------------- | ----------------------- |
| system (`client_credentials`, correct username)         | `/v1/campaign/dump`   | 200                     |
| coordinator (password grant, real `signalstack_org_id`) | `/v1/campaign/dump`   | 403                     |
| portal / BFF service token                              | `/v1/campaign/dump`   | 403 (wrong `azp`)       |
| none                                                    | `/v1/campaign/dump`   | 401                     |
| system                                                  | `/v1/campaign/export` | 403 (reverse direction) |
| misprovisioned service account (has `aggregator_id`)    | `/v1/campaign/export` | 403                     |
| misprovisioned service account                          | `/v1/campaign/dump`   | 200                     |

Also:

- 404 when any one of the three objects is missing, for each of the three, and
  `files` is never partial.
- 503 when S3 throws, and 503 when `CAMPAIGN_DUMP_INSTANCE_ID` is unset.
- `expires_at` reflects `CAMPAIGN_DUMP_URL_TTL_SECONDS`.
- The response body contains no S3 credentials, and its URLs point at the public
  endpoint host.
- `CAMPAIGN_DUMP_SERVICE_ACCOUNT` set to an empty or whitespace-only value does
  not disable the gate.

## Keycloak realm

`infra/keycloak/realms/realm.json` has **no `campaign-manager` client** today —
its clients are `aggregator-portal`, `aggregator-api`, `aggregator-bff`,
`signals-ui`, `signals-api`, `aggregator-dpg`, `voice-dpg`. Local testing of any
campaign route therefore requires a hand-made client. This work adds it:

- confidential, `serviceAccountsEnabled: true` (the system grant),
  `directAccessGrantsEnabled: true` (the coordinator password grant)
- `profile` in default client scopes — `preferred_username` comes from there and
  the gate depends on it
- mappers mirroring `aggregator-portal`, so coordinator tokens carry
  `aggregator_id` and `signalstack_org_id`
- a service account with **no** org attributes

**Before any local test, the existing local realm must be repaired.** Its
hand-made `campaign-manager` client has a service-account user carrying
`aggregator_id`, `aggregator_type` and `signalstack_org_id`. Committing
`realm.json` does not fix that — the file is imported on a fresh realm. Either
strip those three attributes from the service-account user by hand, or re-import
the realm.

## Cross-repo work

**bluedots-automation**

- **before handing EkStep the client secret**, confirm `KEYCLOAK_ALLOWED_AZP` is
  set on every deployment and excludes `campaign-manager`. `access-token.ts`
  disables the `azp` gate entirely when that var is unset (pre-existing
  behaviour), but this is the first work that puts a realm _service-account_
  credential into an external organisation's hands — an unset var would let it
  pass `authenticateAny` on `POST /v1/aggregator-registrations`,
  `POST /v1/orgs` and `GET /v1/orgs`
- repoint the `signals-s3-export` cron at the aggregator bucket (#163), layout
  and export process unchanged, and confirm the prefix it writes
- provision the deployed `campaign-manager` service account with no org attributes
- **revoke the campaign manager's direct S3 IAM access** once this endpoint is live

**campaign-manager (external / EkStep)**

- switch from direct S3 reads to `GET /v1/campaign/dump`, using a
  `client_credentials` token on the existing `campaign-manager` client
- use that credential _only_ for this endpoint; the org-scoped routes continue to
  use coordinator login tokens
- fetch each pre-signed URL and download promptly — do not cache the URL past its
  TTL
- decide how to handle a `last_modified` mismatch across the three files

**aggregator-dpg, separately**

- file the `aggregator-maintenance.ts:145` service-account check bug. Note that
  both `apps/api/CLAUDE.md` ("Service-account-only endpoints additionally gate on
  `subject.startsWith('service-account-')`") and the root `CLAUDE.md` describe
  that gate as working, so the docs need correcting alongside the code.

## Acceptance

- The campaign manager retrieves the full non-PII dump using only a Keycloak
  `client_credentials` token, holding no S3 credentials.
- A coordinator token cannot reach this endpoint, and a system token cannot reach
  the org-scoped campaign routes. Both directions are covered by tests.
- The response is always all three files or an error, never a partial set.
- Every call is logged with the calling client, subject, and the objects served.

## Deliberate deviations from issue #692

| #692 says                                                        | this design                                  | why                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| resolve via `latest_manifest.json`                               | HEAD three fixed keys                        | the exporter no longer writes a manifest                                                                                                                                                                                                     |
| validate the manifest with Zod                                   | not applicable                               | no manifest                                                                                                                                                                                                                                  |
| add `getObjectText`                                              | not needed                                   | no manifest                                                                                                                                                                                                                                  |
| a run in progress is never served                                | skew is served, surfaced via `last_modified` | no atomic pointer upstream to enforce it                                                                                                                                                                                                     |
| separate `campaign-manager-system` client                        | one client, two grant types                  | avoids a second client and credential                                                                                                                                                                                                        |
| new `CAMPAIGN_DUMP_ALLOWED_AZP`                                  | reuse `campaignManagerAllowedAzp()`          | same client, same `azp`                                                                                                                                                                                                                      |
| gate on the `service-account-` subject prefix                    | gate on `preferred_username`                 | `sub` is a UUID for service accounts too                                                                                                                                                                                                     |
| rate limit the route                                             | no in-code limit                             | Kong owns rate limiting platform-wide                                                                                                                                                                                                        |
| `GET /v1/campaign/dump/latest`                                   | `GET /v1/campaign/dump`                      | no history, so nothing to distinguish                                                                                                                                                                                                        |
| `run_id` / `generated_at` in the response                        | omitted                                      | no manifest to source them from                                                                                                                                                                                                              |
| add `CAMPAIGN_DUMP_PREFIX` etc.                                  | kept, plus `CAMPAIGN_DUMP_INSTANCE_ID`       | the instance segment has no other source                                                                                                                                                                                                     |
| startup logs a warning when `CAMPAIGN_DUMP_INSTANCE_ID` is unset | not built                                    | most deployments never use the campaign manager, so a permanent boot warning would be noise on all of them; a genuine misconfiguration surfaces the first time the caller hits the endpoint, and the 503's `hint` names the missing variable |
