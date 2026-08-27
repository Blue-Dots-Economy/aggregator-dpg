# Private object storage with pre-signed URLs — aggregator-dpg design

**Date:** 2026-08-22
**Status:** proposed
**Scope:** `apps/api`, `apps/worker`, `apps/web`, `packages/db-schema`, local compose
**Sibling PRs:** `bluedots-automation` (buckets, IAM, lifecycle, Helm wiring) · `bluedots-infra-deployments` (per-env flip + object migration)
**Not affected:** `signals-dpg` — it has no object-storage code path at all (verified: no `@aws-sdk/*` dependency, no `S3Client`, no bucket env var).

## 1. Why this exists

The aggregator's object storage is provisioned as a **public-read S3 bucket**. `bluedots-automation`'s
storage module attaches a `PublicReadGetObject` statement with `Principal: "*"` to every bucket of
`type = "public"`, and turns all four `block_public_*` flags **off** for it. The only thing standing
between the internet and the objects is an `aws:Referer` string match — a request header any client
can set. All four live environments (`up-gzb` prod, `Ontac` prod, `Ekstep` blue dev, `Ekstep` purple
dev) provision exactly one aggregator bucket, `type: public`, and the generated
`global.s3.bucket` points the aggregator at it.

What is sitting in that bucket:

| Object                                             | Contents                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `bulk-uploads/{aggregator_id}/{upload_id}/raw.csv` | Raw participant CSV — **name, phone, and every other profile field** |
| `bulk-uploads/{upload_id}/errors.csv`              | Failed rows, verbatim — same PII                                     |
| `qr/{aggregator_id}/{link_id}.png`                 | Registration-link QR codes                                           |

Anyone who can guess or obtain a key can `GET` it with a spoofed `Referer` and no credentials. Object
keys embed UUIDs so they are not trivially enumerable, but that is obscurity, not access control.

**The good news: almost all of the application-side work is already done.** This repo never hands a
durable object URL to a browser. It presigns every browser interaction and persists object **keys**,
not URLs:

- `bulk_uploads.s3_key` (`packages/db-schema/src/schema.ts:290`)
- `bulk_uploads.errors_csv_s3_key` (`:296`)
- `registration_links.qr_object_key` (`:332`)

`registration_links.public_url` is the **landing-page** URL built from `PUBLIC_LINK_BASE_URL`, not an
S3 URL. So **there is no persisted-public-URL backfill to do in this repo** — established by code
reading, and to be confirmed per environment by the audit query in §3.5 before any cutover. Making the bucket
private is, for the application, mostly a configuration change plus the three corrections in §3.

## 2. Current object-storage surface

**`apps/api/src/services/object-storage/index.ts`** — two cached clients: `getInternalClient()` on
`S3_ENDPOINT` for server-side ops, `getPresignerClient()` on `S3_PUBLIC_ENDPOINT || S3_ENDPOINT`
because a pre-signed URL encodes the host the browser must reach.

| Export                     | Line   | Role                                                  |
| -------------------------- | ------ | ----------------------------------------------------- |
| `signBulkUploadUrl`        | `:86`  | pre-signed **PUT**, `ContentType: text/csv` signed in |
| `headObject`               | `:120` | confirm the browser's PUT landed, capture ETag        |
| `putObject`                | `:142` | server-side write (QR PNG)                            |
| `signErrorsCsvDownloadUrl` | `:166` | pre-signed **GET**, `Content-Disposition: attachment` |
| `signQrDownloadUrl`        | `:184` | pre-signed **GET** for the QR PNG                     |

**`apps/worker/src/object-storage.ts`** — single internal client: `getCsvStream:52` (GET, streamed
into the parser), `putObject:69` (writes `errors.csv`).

**Call sites**

- `apps/api/src/routes/bulk-uploads.ts` — mints the upload URL, HEADs on `/start`, presigns
  `errors.csv` at `/v1/bulk-uploads/:id/errors.csv`; the expected key is rebuilt at `:627`.
- `apps/api/src/routes/registration-links.ts` — writes the QR PNG (`:337`, `:653`), presigns it
  (`:353`, `:669`, `:793`), key built at `:323` / `:639`.
- `apps/worker/src/jobs/bulk-file-process.ts` — streams the raw CSV.
- `apps/worker/src/jobs/bulk-finalise.ts` — builds and PUTs `errors.csv` (`:124`–`:143`).
- `apps/web/src/app/api/bulk-uploads/**` — BFF proxies only; they forward the API's response and
  never touch S3.

**Config** — `apps/api/src/config.ts:122`–`:165` (`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`,
`BULK_UPLOAD_URL_TTL_SECONDS`, `BULK_UPLOAD_MAX_BYTES`, `QR_DOWNLOAD_URL_TTL_SECONDS`);
`apps/worker/src/config.ts:37`–`:45`.

Local dev runs MinIO (`docker-compose.yml`, `local-setup/docker-compose.yml`). **MinIO is already
private** — `mc anonymous set download` is never run, so no local bucket policy has to be undone.

## 3. Changes in this repo

### 3.1 One canonical signed-URL TTL, defaulting to 10 minutes

Today there are two independent TTLs, both defaulting to **900s (15 min)**, and `errors.csv`
downloads borrow the _upload_ TTL (`index.ts:174` — noted in its own comment as a reuse).

Introduce a single canonical key and make the existing two optional overrides:

| Var                           | Default                | Applies to                              |
| ----------------------------- | ---------------------- | --------------------------------------- |
| `SIGNED_URL_TTL_SECONDS`      | **600**                | every pre-signed URL this service mints |
| `BULK_UPLOAD_URL_TTL_SECONDS` | _(unset → falls back)_ | upload PUT only                         |
| `QR_DOWNLOAD_URL_TTL_SECONDS` | _(unset → falls back)_ | QR GET only                             |

In `apps/api/src/config.ts`: add `SIGNED_URL_TTL_SECONDS` (`z.coerce.number().int().positive().default(600)`),
change the two existing keys to `.optional()`, and expose resolved accessors so call sites never
reach for a fallback themselves — per `.claude/rules/configuration-discipline.md`, resolution belongs
in the config module, not at the use site.

Add a distinct `signErrorsCsvDownloadUrl` TTL source (currently the upload TTL) so an operator
lengthening upload time doesn't silently lengthen download exposure.

**Upper bound.** Reject `SIGNED_URL_TTL_SECONDS > 3600` at boot. A pre-signed URL cannot be revoked;
an operator who sets 7 days has created a durable public URL and undone this whole change. Boot
failure with a clear message is the right outcome — see `.claude/rules/error-handling.md`.

### 3.2 Tenant-prefix the `errors.csv` key

`bulk-finalise.ts:124` writes `bulk-uploads/{upload_id}/errors.csv` — **no `aggregator_id` segment**,
unlike the raw CSV at `object-storage/index.ts:90`. Authorization is enforced correctly at the route
(`bulk-uploads.ts` loads the row and checks ownership before presigning), so this is not a live
vulnerability. But it means the key namespace is not tenant-partitioned, which blocks any future
prefix-scoped IAM or bucket policy, and it is the kind of asymmetry that a later refactor gets wrong.

Target namespace — restructured so **retention is expressible as a prefix**, which S3 lifecycle
rules require (see §3.3):

```
uploads/raw/{aggregator_id}/{upload_id}.csv      # transient
uploads/errors/{aggregator_id}/{upload_id}.csv   # transient, longer
qr/{aggregator_id}/{link_id}.png                 # durable
```

**No backfill.** Both keys are already persisted per row, so reads use the stored value verbatim and
old objects keep resolving. Only newly created objects get new keys.

**The trap — and what _not_ to do about it.** `bulk-uploads.ts:627` rebuilds the expected errors key
from `upload.id` and refuses to sign anything that doesn't match:

```ts
const expectedKey = `bulk-uploads/${upload.id}/errors.csv`;
if (upload.errorsCsvS3Key !== expectedKey) {
  /* 404 + log errors_csv_key_invalid */
}
```

Its own comment says why: _"only sign keys that match the canonical errors.csv layout … guards
against any future path (or DB tamper) signing a GET URL for an arbitrary object."_ This is a
**deliberate security control — a signing allow-list**, not a redundant recomputation. Replacing it
with "just read the column" would let any write path that can influence `errors_csv_s3_key` mint a
pre-signed GET for an arbitrary object in the bucket. That is strictly worse than the public bucket
this change is meant to fix.

The correct change is to make the allow-list accept **both** layouts:

```ts
const allowed = [
  `uploads/errors/${upload.aggregatorId}/${upload.id}.csv`, // new
  `bulk-uploads/${upload.id}/errors.csv`, // legacy, pre-migration rows
];
if (!allowed.includes(upload.errorsCsvS3Key)) {
  /* reject as today */
}
```

Once the legacy retention window (§3.3) has elapsed, the legacy entry can be dropped. Track that as a
dated follow-up rather than leaving it permanently — an allow-list that only ever grows stops being
one.

### 3.3 Object classification for lifecycle expiry

The bucket lifecycle rules themselves are infrastructure (`bluedots-automation`), but the
classification is a product decision and belongs here. `apps/worker/src/jobs/cron-watchdog.ts:11`
already documents the assumption that "S3 lifecycle (raw CSVs + errors.csv) is configured externally"
— that configuration has never existed.

| Class          | Prefix            | Retention                   | Rationale                                                                                                                                                                   |
| -------------- | ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw upload CSV | `uploads/raw/`    | **7 days**                  | Consumed by the worker within minutes. Kept a week only so a failed run can be re-driven and support can reproduce a complaint. Highest-PII object we hold — shortest life. |
| Errors CSV     | `uploads/errors/` | **30 days**                 | The aggregator's own worklist for fixing rejected rows; they need more than a week to act, and the dashboard links to it.                                                   |
| QR PNG         | `qr/`             | **durable — never expires** | Deterministically regenerable from the link, but a printed QR outlives any TTL; expiring it breaks physical collateral already in the field.                                |

Retention is deployment-configurable, not hardcoded — see the automation doc for variable names.

**Versioning interacts with this.** If the private bucket has versioning enabled (the existing
`private` bucket template does), a plain `Expiration` rule only adds a delete marker — the PII stays
in a noncurrent version forever. Every transient rule **must** be paired with
`NoncurrentVersionExpiration`, plus `AbortIncompleteMultipartUpload`. Missing this is the most likely
way this change ships looking complete while retaining every CSV indefinitely.

### 3.4 QR downloads: stop presigning in list responses

The QR path is **already fully pre-signed** — `buildResponse` (`registration-links.ts:775`) mints
`qr_url` per row via `signQrDownloadUrl` and returns it alongside `qr_expires_at`; the portal renders
it as an `<a href target="_blank">` (`RegistrationLinksSection.tsx:555`–`:557`), never an `<img src>`.
So no browser ever needs unauthenticated bucket access for a QR. That part is right today.

Two problems, both made worse by cutting the TTL from 900s to 600s:

1. **Every list response presigns every row.** `GET /v1/links` batches metrics into one grouped query
   and fans out with `Promise.all` (`:411`–`:421`) — the DB access is already clean. But it still
   computes one SigV4 signature per row for a URL the operator usually never clicks. At `limit=50`
   that is 50 HMAC-SHA256 signings and ~50 extra URLs (each several hundred bytes of query string) on
   the wire, per page view, per poll.
2. **Every URL starts dying on serialization.** A page left open for 11 minutes has a QR link that
   fails with an opaque S3 `AccessDenied` XML body. The API already returns `qr_expires_at` and the UI
   ignores it, so nothing refreshes and nothing explains the failure.

Fix both with one change — **mint on click, not on list**:

- Add `GET /v1/links/:id/qr`: authorize as today, then return a freshly minted pre-signed GET URL.
- List and single-link responses return a stable, non-expiring **relative path**
  (`qr_download_path: "/v1/links/{id}/qr"`).
- `qr_url` / `qr_expires_at` stay on the wire but are populated **only** by the handler that just
  minted one (create / activate). They are `null` on every read and list.

This removes N signings per page, shrinks the payload, and makes staleness structurally impossible —
the URL is minted milliseconds before the browser follows it, so a 600s TTL (or a 60s one) is
comfortable. It also removes the only reason a pre-signed URL was ever serialised into a list
response, which is the thing most likely to end up in a log, a screenshot, or a support ticket.

The response must send `Cache-Control: no-store`. A cached response would pin one expiring URL into
the browser cache and reintroduce exactly the staleness being removed.

**Implementation deviation from this section, and why.** The first draft specified a `302` redirect.
The implementation returns **JSON** (`{ link_id, url, expires_at }`) instead, because:

1. It mirrors the existing `GET /v1/bulk-uploads/:id/errors.csv` endpoint exactly — same shape, same
   `passthrough()` BFF proxy. A redirect would have needed bespoke `redirect: 'manual'` handling in
   the Next.js BFF to forward a `Location` header, i.e. a second pattern for the same job.
2. The client cost is one synchronously-opened blank tab whose `location` is set once the URL
   arrives. That is required regardless: a `window.open` _after_ an await is treated as unsolicited
   and blocked by popup blockers, so the anchor could not have stayed a plain `<a href>` under either
   design.

The security and performance properties are identical; only the transport differs. Both are covered
by tests, including that a list response contains no `X-Amz-Signature` anywhere.

**Signing allow-list here too.** The endpoint refuses to sign any `qr_object_key` that is not
`qr/{caller_aggregator_id}/{link_id}.png`, matching the errors-CSV posture in §3.2. Without it, a
tampered column would turn this into a pre-signed read of any object in the bucket.

### 3.5 Pre-migration audit: prove nothing stored is a URL

§1 asserts there are no persisted object URLs, from reading the code. That is necessary but not
sufficient — a URL pasted into a free-form `jsonb` column would not show up in a grep for
`getSignedUrl`. Run this against **each** environment's database before the cutover and attach the
output to the migration ticket:

```sql
-- 1. Key columns must hold keys, never URLs. Expect 0 rows.
SELECT 'bulk_uploads.s3_key' AS col, id, s3_key AS val
  FROM bulk_uploads WHERE s3_key ~ '://'
UNION ALL
SELECT 'bulk_uploads.errors_csv_s3_key', id, errors_csv_s3_key
  FROM bulk_uploads WHERE errors_csv_s3_key ~ '://'
UNION ALL
SELECT 'registration_links.qr_object_key', id, qr_object_key
  FROM registration_links WHERE qr_object_key ~ '://';

-- 2. Free-form jsonb must not carry a bucket reference. Every schema-driven
--    payload column, not just the obvious ones. Expect 0 rows.
WITH pat AS (SELECT '(amazonaws\.com|s3://|X-Amz-Signature|X-Amz-Credential)' AS re)
SELECT 'registration_links.context' AS col, id::text FROM registration_links, pat WHERE context::text            ~* re
UNION ALL SELECT 'aggregators.profile',              id::text FROM aggregators,        pat WHERE profile::text            ~* re
UNION ALL SELECT 'aggregator_orgs.profile',          id::text FROM aggregator_orgs,    pat WHERE profile::text            ~* re
UNION ALL SELECT 'participants.data',                id::text FROM participants,       pat WHERE data::text               ~* re
UNION ALL SELECT 'link_submissions.submitted_data',  id::text FROM link_submissions,   pat WHERE submitted_data::text     ~* re
UNION ALL SELECT 'link_submissions.metadata_snapshot', id::text FROM link_submissions, pat WHERE metadata_snapshot::text  ~* re;

-- 3. Sanity: aggregators.url is the org's WEBSITE (Beckn actor), not object
--    storage. Eyeball it; a bucket hostname here means someone repurposed it.
SELECT id, org_slug, url FROM aggregators WHERE url IS NOT NULL;
```

`participants.data` and `link_submissions.submitted_data` hold schema-driven participant payloads, so
a future network schema _could_ legitimately introduce a document field — which is exactly why they
are in the query rather than reasoned about. Two columns that look like object references but are
not, and should not be chased:

- `aggregator_profile.verified_certificate` is `PublicKeyEntry[]` — cryptographic public keys keyed by
  `key_id`, not uploaded files.
- **Support-form attachments never touch object storage.** `apps/api/src/routes/support.ts` accepts
  them base64-encoded in the request body (hence the raised body limit at `:123`), validates them via
  `validateSupportAttachments`, and hands them straight to the mailer as inline attachments. Nothing
  is written to S3 and nothing is persisted. The feature name invites the opposite assumption.

Query 1 returning rows means the "no backfill" premise is wrong for that environment and the
migration plan needs a rewrite-and-backfill step. **Do not proceed on the assumption; run it.** If
query 3 shows a bucket hostname, treat it the same way.

### 3.6 Nothing else moves

`S3_PUBLIC_ENDPOINT` stays as-is: for real AWS it is unset and the presigner uses the regional
endpoint. `S3_FORCE_PATH_STYLE` stays. The two-client split stays — it is exactly what a private
bucket needs. No new endpoint, no new route, no schema migration.

## 4. Auth and authz

Unchanged, and deliberately so. Every mint goes through `requireApproved`
(`apps/api/src/services/auth/access-token.ts:179`), which derives `aggregatorId` from the Keycloak
session. **`aggregator_id` is never read from the request body, query, or a header** — the invariant
holds today and this change must not weaken it. Specifically:

- No endpoint may accept an object key from the client and presign it. The key is always derived
  server-side from a row the caller has been proven to own.
- The `{aggregator_id}` segment in a key is a _grouping and lifecycle_ device, not an authorization
  boundary. Authorization is the row-ownership check. Do not let the prefix become load-bearing.
- Pre-signed URLs are bearer credentials for one object. They must never be logged
  (`.claude/rules/logging-observability.md`) or persisted. Audit the _mint event_ with the key, not
  the URL.

## 5. Test plan (Vitest)

- `signBulkUploadUrl` / `signQrDownloadUrl` / `signErrorsCsvDownloadUrl` honour
  `SIGNED_URL_TTL_SECONDS`, and each per-class override wins when set.
- Boot fails when `SIGNED_URL_TTL_SECONDS` exceeds the 3600s ceiling.
- New objects get `uploads/raw/…` / `uploads/errors/…` keys with the `aggregator_id` segment.
- **Legacy-key regression:** a `bulk_uploads` row whose `errors_csv_s3_key` is the old
  `bulk-uploads/{id}/errors.csv` still presigns and downloads. This is the test that catches §3.2's
  trap.
- **Allow-list still rejects:** a row whose `errors_csv_s3_key` is neither layout — e.g.
  `qr/{other_aggregator}/x.png`, or `uploads/errors/{other_aggregator}/{id}.csv` — is refused with
  `errors_csv_key_invalid` and **no URL is minted**. Without this test, widening the allow-list in
  §3.2 silently becomes "sign whatever the column says".
- Cross-tenant: aggregator B requesting A's `upload_id` gets 404/403 and **no URL is minted**.
- **QR mint endpoint (§3.4):** `GET /v1/links/:id/qr` returns JSON carrying a URL with
  `X-Amz-Signature` and sets `Cache-Control: no-store`; a link owned by another aggregator gets 403
  and mints nothing; a `draft`/`retired` link gets 404 (matching `buildResponse`'s existing rule that
  only `live` links expose a QR); a stored `qr_object_key` that is not the canonical key for this
  caller + link is refused, as are another tenant's prefix and another object class.
- **Per-class TTL wiring**, with three _distinct_ TTLs so the assertion cannot pass with the classes
  swapped. Tested by mutation: swapping `errorsCsvDownload` for `bulkUpload` at the call site fails
  the suite. The default-config tests cannot catch this — all three classes resolve to 600.
- **Boot guards** on the TTL surface: over-ceiling, empty string, zero, negative and non-numeric all
  refuse to boot, and the ceiling applies to per-class overrides too.
- **Popup-blocked path:** when `window.open` returns `null` the client must NOT navigate the current
  tab — that would replace the portal with a raw storage URL and write a bearer credential into the
  address bar and browser history. Also asserts the feature string omits `noopener`, since that makes
  `window.open` return `null` by spec and would leave nothing to navigate.
- **List responses carry no signed URL** once `qr_url` is retired — assert the serialized list
  contains no `X-Amz-Signature`. This is the regression guard against someone reintroducing per-row
  presigning.
- Existing bulk-upload and registration-link suites pass unchanged — the presign surface is stable.

Integration coverage runs against MinIO, which is already private, so the local suite exercises the
target posture without new fixtures.

## 6. Risks

| Risk                                                                         | Mitigation                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bucket flipped to private before objects are copied → existing downloads 404 | Automation/infra sequencing: provision private, sync, _then_ flip. See the infra-deployments doc.                                                           |
| CORS missing on the private bucket → browser PUT fails preflight             | The private bucket **must** carry `cors_enabled: true`. The current `private` bucket template does not. Called out in the automation doc.                   |
| §3.2 read as "drop the `expectedKey` check" → arbitrary-object signing       | The check is a security allow-list. Widen it, never remove it; guarded by the allow-list rejection test.                                                    |
| Legacy `errors.csv` keys break after the key move                            | Legacy-key regression test; legacy entry stays in the allow-list for the retention window.                                                                  |
| `qr_url` retired before the portal switches to `qr_download_path`            | Keep both for one release; retire `qr_url` + `qr_expires_at` only after `apps/web` ships the new path.                                                      |
| TTL shortened too aggressively → large CSV upload times out mid-PUT          | 600s at 10 MiB (`BULK_UPLOAD_MAX_BYTES`) is ~140 kbit/s to fail; acceptable. Keep `BULK_UPLOAD_URL_TTL_SECONDS` as the override for slow-link environments. |

## 7. Open questions

1. Is 30 days right for `uploads/errors/`, or should it track a stated data-retention commitment to
   aggregators? Needs a product answer, not an engineering one.
2. Should `errors.csv` downloads move behind the same redirect treatment as §3.4? They are already
   single-object, on-demand endpoints, so the payoff is only consistency — worth doing when the QR
   endpoint lands, not before.
3. The `signals-export` bucket is already `type: private` and written by a separate write-only IRSA
   role. Confirmed out of scope for this change.

## 8. Adjacent findings — deliberately not in this change

Surfaced while tracing the object-storage paths. Not an object-storage problem, so folding it in
would widen the diff past what the migration needs. Recorded so it is not lost.

1. **Sequential Redis round-trips in the bulk-upload list.** `apps/api/src/routes/bulk-uploads.ts`
   batches finished uploads via one grouped SQL read, then falls back to a per-upload Redis fetch for
   in-flight rows in a serial loop:

   ```ts
   for (const u of liveUploads) {
     out.set(u.id, await loadCountsFromRedis(u.id));
   }
   ```

   One awaited round-trip per in-flight upload, serialized. An aggregator with 20 uploads in progress
   pays 20 sequential RTTs on every dashboard poll. `Promise.all` over the same calls — or a single
   pipelined `MGET`/`HMGET` — collapses it to one. Contrast `registration-links.ts:417`, which already
   fans out with `Promise.all`. Worth its own PR.
