# Object storage behind an interface — design

Issue: Blue-Dots-Economy/aggregator-dpg#933
Status: reviewed (aggregator-dpg#933 review comment, 2026-11-09) and agreed; ready for implementation
Branch: `refactor/933-object-storage-interface` (cut from `origin/feature`)

## 1. Why

The aggregator can only store files in Amazon S3 or an S3-compatible store
such as MinIO. The AWS SDK is called directly from two places, so an adopter
whose cloud is not S3-like cannot run the aggregator without changing code.

This change puts object storage behind one interface in this repo, with S3
as the first and, for now, only provider. Adding another provider later means writing one new
provider and changing a config value, with no change to the features that
store files.

The interface is cut for more than today's three uses. Known and upcoming
uses it must not rule out:

- signals-dpg#566: file fields on profiles (uploads by public users,
  visibility, PII, deletion).
- aggregator-dpg#833 / #407: large exports sent by email (10k–50k rows).
- ai-diffusion-dpg#67: call recordings (large files written as a stream,
  with retention).
- ai-diffusion-dpg `knowledge_engine/src/storage/`: an existing Python
  storage layer (Azure Blob + local PVC).
- On-prem sites (ALIMCO, Tata Cloud) running self-hosted MinIO with a public
  endpoint, its own TLS and a Host-header rule.

## 2. What uses object storage today

Three features, spread across two apps:

| Feature                     | What is stored                        | Operations used                                                                                                                                                 | Where                                                                                                                                                              |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bulk CSV upload             | The CSV a coordinator uploads         | Pre-signed **upload** URL (the browser PUTs the file straight to storage); **HEAD** (exists, size, ETag) to confirm the upload; **streamed read** in the worker | `apps/api/src/routes/bulk-uploads.ts` (create, `/start`), `apps/web/src/services/onboarding.service.ts` (browser PUT), `apps/worker/src/jobs/bulk-file-process.ts` |
| Bulk upload errors CSV      | The report of rejected rows           | **Write** (worker); pre-signed **download** URL (api)                                                                                                           | `apps/worker/src/jobs/bulk-finalise.ts`, `apps/api/src/routes/bulk-uploads.ts` (errors download)                                                                   |
| Campaign participant export | The PII export a coordinator requests | **Write**; pre-signed **download** URL sent by email (valid 24 h by default)                                                                                    | `apps/worker/src/services/campaign-process/index.ts`, `apps/worker/src/jobs/campaign-process.ts`                                                                   |

The S3 code itself lives in two near-identical files, each building its own
S3 clients from its own copy of the `S3_*` config:

- `apps/api/src/services/object-storage/index.ts` — `signBulkUploadUrl`,
  `headObject`, `signErrorsCsvDownloadUrl`, and an unused `putObject`.
- `apps/worker/src/object-storage.ts` — `getCsvStream`, `putObject`,
  `signExportDownloadUrl`.

Both keep two S3 clients: an internal one (`S3_ENDPOINT`) for server-side
calls, and a presigner (`S3_PUBLIC_ENDPOINT`, falling back to `S3_ENDPOINT`)
so signed URLs point at a host the browser can reach.

Nothing else in this repo stores files, and Signals-DPG has no storage code.
The Signals `s3-export` cron job (adhoc-scripts) is being replaced by
`platform-sync`, and the aggregator `/v1/campaign/dump` route is already
removed on `feature`; both are out of scope.

Today no code deletes an object, and the only bucket lifecycle rule expires
`campaign-exports/` (`bluedots-automation/opentofu/aws/modules/storage/main.tf`).
Files under `bulk-uploads/`, which are raw participant CSVs (PII), are kept
indefinitely. Section 8 covers this.

## 3. Goals, non-goals, anti-goals

**Goals**

- One object-storage interface in this repo, shared by the api and the
  worker, with S3 as a provider behind it.
- A `STORAGE_PROVIDER` setting chooses the provider. Switching to another
  provider, once one exists, is a config change only.
- The features depend only on the contract, never on a storage SDK.
- Oversized bulk uploads are refused at upload time, and every file the api
  rejects is deleted (section 7).
- `bulk-uploads/` files expire after a configurable retention (section 7).
- Writing a new provider is obvious from the code, and every provider is
  held to the same behaviour by one shared test suite.

**Non-goals**

- Shipping any provider other than S3.
- Building a provider that serves files through the api (section 4.6 keeps
  room for it).
- Areas other than the two used today; public visibility.
- An organisation-wide contract document (for example in bluedots-docs), or
  changing the Python storage layer in ai-diffusion-dpg.
- Publishing the package to npm or moving it to its own repo.
- Loading providers at runtime as separate plugins, so that an image carries
  only the provider its deployment uses. Discussed and not needed now; with
  S3 as the only provider there is no unused provider code.
- Renaming the `s3` database columns, queue field or API fields (section 6.2).

**Anti-goals** (this would be a failure even if it technically works)

- Any behaviour change for existing S3/MinIO deployments other than the
  oversized-upload fix, the retention and the owner-first key of new errors
  reports: same env vars, same object keys,
  same download URLs, same stored values.
- The contract leaking S3 concepts (bucket, ETag quoting, path style,
  `Command` objects, POST policies) to callers.
- Two copies of the storage code surviving the change.
- Feature code choosing top-level folders itself instead of naming an area.

## 4. Design

### 4.1 A shared package: `@aggregator-dpg/object-storage`

A new workspace package under `packages/object-storage`, scaffolded from
`packages/_template` and used by both `apps/api` and `apps/worker`. Its shape
follows the existing `@aggregator-dpg/mailer` package (`MailerAdapter`
contract, `smtp` and `ses` providers, `MAIL_PROVIDER` to choose, a fake for
tests) and the repo rules in `.claude/rules/base-class-pattern.md` and
`.claude/rules/interfaces.md`. It differs from the mailer in two ways: it
takes parsed config from the apps instead of reading `process.env`, and it
fails at startup, not on first use.

| File                     | Subpath export | Purpose                                                                                                                                                                                  |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/interface.ts`       | `./interface`  | `ObjectStorageBase` abstract class, input/output types                                                                                                                                   |
| `src/areas.ts`           | `./areas`      | The area definitions (section 4.2)                                                                                                                                                       |
| `src/config.ts`          | `./config`     | Storage config field-set (`STORAGE_PROVIDER` + each provider's settings), spread into both apps' config schemas                                                                          |
| `src/providers/s3/s3.ts` | none           | `S3ObjectStorage extends ObjectStorageBase`; all `@aws-sdk/*` imports live here only. Each provider has its own folder under `src/providers/`, with its tests in `__tests__/` beside it. |
| `src/index.ts`           | `.`            | `getObjectStorage()` factory: provider choice, process-wide singleton, test override                                                                                                     |
| `src/testing.ts`         | `./testing`    | In-memory fake extending `ObjectStorageBase`, and the shared provider test suite (section 5)                                                                                             |

Provider files are not exported, so apps cannot import a provider directly:
they reach a provider only through `getObjectStorage()`. The package's
`exports` map enforces this; `pnpm dep-check` scans `packages/` only, so it
does not need to change.

The `@aws-sdk/*` dependencies move from `apps/api` and `apps/worker` into
this package. Apart from them it depends only on
`@aggregator-dpg/shared-primitives` (not on `@aggregator-dpg/observability`:
it returns results and the callers log), so it can be moved out of this repo
later without changes.

### 4.2 Areas

Every object belongs to a named **area**. An area declares:

| Field      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| Name       | How code refers to it                                         |
| Prefix     | The folder its objects live under                             |
| Retention  | How long its objects are kept before the storage deletes them |
| Visibility | `private` (only reachable through a signed link) or `public`  |

Two areas are defined in this change, both matching today's paths, so no
existing object moves:

| Area           | Prefix              | Retention                                         | Visibility |
| -------------- | ------------------- | ------------------------------------------------- | ---------- |
| `bulk-uploads` | `bulk-uploads/`     | Configurable; default to be confirmed (section 7) | private    |
| `exports`      | `campaign-exports/` | `global.campaignExportExpiryDays` (default 1 day) | private    |

Further areas (`profile-files`, recordings, …) are added when those features
are built, the same way.

Only `private` exists. A `public` area would need its own bucket and an
operation that returns a public URL; both are added when profile files need
them. All areas share `S3_BUCKET`. A bucket per area is not needed now; it can
be added later as an optional per-area setting that defaults to `S3_BUCKET`.

Callers name the area on every operation and pass the full object key, the
same value the database stores (for example
`bulk-uploads/<aggregatorId>/<uploadId>/raw.csv`). There is no conversion in
either direction. The provider rejects a key that does not start with the
area's prefix, or has nothing after it, with a `ValidationError`.

New keys are built with `buildKey(area, ownerId, ...segments)`, which returns
`<area prefix><ownerId>/<segments joined by '/'>`. The rule is that every key
starts with its owner, so a later folder operation can reach one owner's
files. The errors CSV layout without an owner
(`bulk-uploads/<uploadId>/errors.csv`) is legacy: the api still serves it, and
those files expire under retention.

Feature code no longer chooses the top-level folder.
`src/areas.ts` is the one declaration of area names, prefixes and
visibility, and of `buildKey`. Prefixes are not a setting, because changing one would orphan
the objects already stored. The storage lifecycle rules in
bluedots-automation use the same prefixes.

Retention is enforced by the storage itself (an S3 lifecycle rule per prefix),
not by the app. The retention value is a deployment setting in bluedots-automation global values, which already drives
both the export lifecycle rule and the worker's `EXPORT_URL_TTL_SECONDS`.
`bulk-uploads` gets a matching setting (section 7). A later provider without
lifecycle rules must provide its own expiry.

### 4.3 The contract

`ObjectStorageBase` is an abstract class (repo rule: contracts are abstract
classes, not TS interfaces). Every method is abstract and returns
`Promise<Result<T, BaseError>>` from `@aggregator-dpg/shared-primitives`.
Callers decide keys within an area, TTLs and size limits; the provider knows
nothing about bulk uploads or campaigns.

| Operation                                                                                                                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                         | Used by                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Create upload (area, key, content type, max bytes, expiry) → upload instructions `{ method, url, headers, formFields }` + expiry time | Lets a browser upload one object directly by following the instructions, without knowing the provider. A provider that can refuse an oversized file at upload does so (S3: POST policy with `content-length-range`; GCS likewise). One that cannot returns PUT instructions, and the caller's size check plus `delete` covers it. Max bytes is optional: without it the instructions are a plain signed PUT with no size limit. | bulk upload create                                                              |
| Create download URL (area, key, expiry, download filename, content type) → URL, expiry time                                           | Lets a browser or email recipient download one object, served as an attachment with the given filename.                                                                                                                                                                                                                                                                                                                         | errors CSV, campaign export                                                     |
| Stat (area, key) → `{ size, fingerprint }` or "not found"                                                                             | Confirms an upload landed, checks its size, captures a content fingerprint.                                                                                                                                                                                                                                                                                                                                                     | bulk upload `/start`                                                            |
| Open read stream (area, key) → Node `Readable` or "not found"                                                                         | Streams an object without loading it into memory. The caller owns the stream.                                                                                                                                                                                                                                                                                                                                                   | bulk file process                                                               |
| Put (area, key, `Buffer` or `Readable`, content type)                                                                                 | Writes an object. A stream is uploaded in parts, so memory stays bounded for any size.                                                                                                                                                                                                                                                                                                                                          | errors CSV, campaign export                                                     |
| Delete (area, key)                                                                                                                    | Removes an object. Deleting an object that does not exist succeeds.                                                                                                                                                                                                                                                                                                                                                             | bulk upload `/start` (rejected files), later profile files and erasure requests |
| Check health → ok or error                                                                                                            | Optional readiness check that the storage is reachable with the configured credentials.                                                                                                                                                                                                                                                                                                                                         | readiness probe, when wired                                                     |

Notes on the contract:

- **"Not found"** is a success value on stat and on open read stream, not an
  error. Callers decide what it means.
- **Fingerprint** replaces "ETag". For S3 it is today's ETag with the quotes
  stripped, so stored values do not change. It is compared only on the same
  upload row (`markUploaded` treats a repeat `/start` with the same value as
  a no-op), so values from different providers never meet.
- **Upload instructions** may point at the storage or, for a future
  api-served provider, at an api route (section 4.6). Callers never assume
  which.
- **Two endpoints** stay a provider concern. The S3 provider keeps the
  internal client for server-side calls and the public presigner for URLs.
- **Timeouts and retries** keep today's values and become settings with
  those defaults: `STORAGE_CONNECT_TIMEOUT_MS` (5000), `STORAGE_MAX_ATTEMPTS`
  (3) and `STORAGE_WRITE_TIMEOUT_MS` (60000, buffered writes only). Streamed
  reads and streamed writes have no total timeout.
- **Errors**: providers never throw across the boundary. A transport or
  provider failure is returned as an `UpstreamError`; a bad input (including
  an unknown area) as a `ValidationError`. Callers map an error result to
  today's behaviour: in the bulk-upload routes a storage failure answers
  **500 `INTERNAL`** (`apps/api/src/errors/serialize.ts`), and it stays 500;
  worker jobs still fail and retry where they do now.
- **Encryption at rest** is a provider and deployment requirement, because
  exports and bulk uploads contain PII. On AWS the bucket's default encryption
  (`AES256`, bluedots-automation storage module) already covers it; every
  other deployment, including on-prem MinIO, must enable it.
- **Keys**: every operation takes the full stored key and rejects one
  outside the area's prefix (section 4.2).
- **Write order**: a feature writes the file first, then the database row.
  A crash in between leaves an orphan file, which retention removes. A row
  that points at an expired or deleted file is handled by the reader: the
  errors download answers "no longer available", and the raw CSV is read only
  shortly after upload. A streamed put is not retried inside the call; the
  job retries and builds the stream again.
- **Large reads and writes run only in the worker**, never inside an api
  request. The api only signs, stats and deletes.
- **Folder operations** are not built. The contract leaves room for a paged
  `list(area, prefix)` and a `deleteByPrefix(area, prefix)` for erasure and
  clean-up; owner-first keys make one owner's files a single prefix.
- **Not carried over**: the comment in today's api storage module saying the
  size is checked at `/complete`; the route is `/start`.

### 4.4 Choosing the provider: `STORAGE_PROVIDER`

- New optional setting `STORAGE_PROVIDER`, default `s3`, read by both the
  api and the worker.
- The storage settings are declared once, in the package's `./config`
  field-set, and spread into both apps' config schemas, the way
  `signalStackConfigFields` from `@aggregator-dpg/shared-primitives/config`
  is today. This removes the duplicate `S3_*` definitions in
  `apps/api/src/config.ts` and `apps/worker/src/config.ts`; the apps pass
  the parsed values to the factory.
- `s3` builds the S3 provider from the existing `S3_*` settings, which keep
  their names and meanings: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`,
  `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`. Leaving the keys blank still falls back to the
  default AWS credential chain (IAM role / IRSA).
- An unknown value fails at startup with a clear message, never at the first
  upload.
- Each provider owns its settings, named with its own prefix (for example
  `AZURE_STORAGE_*` for a future Azure provider).
- **Required-ness depends on the selected provider.** In the schema every
  provider's settings are optional. A check on the whole config then
  requires the settings of the provider named in `STORAGE_PROVIDER` only, and
  fails startup naming each missing one. An S3 deployment never needs
  `AZURE_STORAGE_*`, and an Azure deployment never needs `S3_*`.
- For `s3` the existing defaults are kept exactly: `S3_REGION` =
  `us-east-1`, `S3_BUCKET` = `aggregator-bulk-uploads`,
  `S3_FORCE_PATH_STYLE` = `true`; `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` and the
  two keys stay optional. No existing deployment gains a required setting.

### 4.5 What stays in the apps

- **Keys** are still chosen by the features, built with `buildKey`. The raw
  CSV and export keys stay exactly as today:
  `bulk-uploads/<aggregatorId>/<uploadId>/raw.csv` and
  `campaign-exports/<orgId>/<jobId>.csv`. New errors reports are written to
  `bulk-uploads/<aggregatorId>/<uploadId>/errors.csv`; the api accepts that
  and the legacy `bulk-uploads/<uploadId>/errors.csv`. Values already stored
  in `bulk_uploads.s3_key` and `errors_csv_s3_key` keep working with no data
  migration.
- **TTLs and limits** stay in each app's config: `BULK_UPLOAD_URL_TTL_SECONDS`,
  `BULK_UPLOAD_MAX_BYTES` (api) and `EXPORT_URL_TTL_SECONDS` (worker). The api
  passes `BULK_UPLOAD_MAX_BYTES` as the upload's max bytes.
- **The create response** of `POST /v1/bulk-uploads` gains one field,
  `upload` (`{ method, url, headers, form_fields }`), which the web app
  follows to upload the file. The existing fields stay. `upload_url` and
  `content_type` are marked deprecated in `openapi.json` and are removed
  later through the API deprecation cycle (signals-dpg#839). Until then
  `upload_url` stays a working signed PUT URL, without the size limit, so a
  client that still PUTs to it keeps working. Today only the web app uses
  them.

### 4.6 How a new provider is written

The recipe the code should make obvious (shown for a future Azure Blob
provider; not part of this change):

1. Add `src/providers/<provider>/<provider>.ts` with a class extending `ObjectStorageBase`, using
   the provider's own SDK. Upload instructions and download URLs map to the
   provider's equivalent of signed URLs (Azure: SAS URLs, with
   `x-ms-blob-type: BlockBlob` in the upload headers; GCS: signed URLs or a
   signed POST policy).
2. Add the SDK as a dependency of `@aggregator-dpg/object-storage` only.
3. Add the provider's settings to `src/config.ts`, and one case to the
   factory in `src/index.ts` that fails fast at startup when a required
   setting is missing.
4. Run the shared provider test suite (section 5) against it.
5. Document the new `STORAGE_PROVIDER` value and its settings in
   `.env.example`.

Every provider and deployment must also handle, outside the code: CORS for
the methods its upload instructions use, retention per area (section 4.2),
and encryption at rest.

**A provider that serves files through the api** (local disk, a PVC, or
on-prem without a public MinIO endpoint) is not built now, and the contract
does not rule it out: its upload instructions and download URLs would point
at signed api routes, which receive or serve the bytes and store them
locally. Building it would add those routes (each a new API, needing
approval) and its own retention sweep.

## 5. Shared provider test suite

`./testing` exports one test suite that describes how any provider must
behave: upload instructions work, an upload over max bytes is refused (or,
for a provider that cannot refuse it, is reported by stat so the caller can
delete it), stat and open read stream report "not found", put accepts a
buffer and a stream, delete removes an object and succeeds when it is
missing, download URLs serve the object with its filename, unknown areas are
rejected, and a key outside its area's prefix is rejected.

The in-memory fake and the S3 provider (run against MinIO) must both pass it,
and so must every future provider. This is what lets the apps' tests trust
the fake.

## 6. The "S3" names outside the S3 provider

After the change, "S3" still appears in some names outside the S3 provider.
The stored values (`bulk-uploads/...`) are provider-neutral; only the names
say S3. `S3_*` env vars configure the S3 provider specifically and keep their
names.

### 6.1 Renamed in this change

These are internal or plain text. Renaming them changes no stored data and
no contract:

| What                               | Today                                                                                                                                                             | After                                                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload error a coordinator can see | `S3 PUT failed (<status>): <body>` (`apps/web/src/services/onboarding.service.ts:263`, shown by `CSVUpload.tsx`)                                                  | Storage-neutral wording, e.g. `File upload failed (<status>)`                                                                                                                                                                                     |
| API route descriptions             | "pre-signed S3 GET URL" and similar (`routes/bulk-uploads.ts`, regenerated into `openapi.json`)                                                                   | "pre-signed download URL" and similar. Descriptions only.                                                                                                                                                                                         |
| Log fields and reasons             | `s3_key`, `s3_object_missing`, `sub: 's3.put'`                                                                                                                    | `storage_key`, `storage_object_missing`, `storage.put`                                                                                                                                                                                            |
| Code names                         | `s3Key`, `s3Etag`, `errorsCsvS3Key` in the bulk-uploads store, route and worker jobs                                                                              | `storageKey`, `contentFingerprint`, `errorsCsvStorageKey` in the bulk-uploads store and route. The Drizzle schema properties are renamed the same way in a separate PR across db-schema, api and worker (approved); the columns keep their names. |
| Dead code                          | `findByAggregatorAndEtag` and the `DUPLICATE_ETAG` error, unused since migration 0012 dropped the unique index they relied on (only a test stub calls the finder) | Deleted                                                                                                                                                                                                                                           |
| Docs                               | `docs/onboarding-design.md`, `docs/onboarding-implementation.md`                                                                                                  | Neutral wording                                                                                                                                                                                                                                   |

No alert or dashboard in bluedots-automation (`helm/monitoring`) reads these
log fields: the alerts and dashboards are metric-based, and Loki has no
log-based rules.

### 6.2 Decided — the contract names are kept

The database columns `bulk_uploads.s3_key`, `s3_etag`, `errors_csv_s3_key`,
the queue job field `s3Key` (`packages/queue/src/index.ts`) and the API
response fields `s3_key`, `errors_csv_s3_key` keep their names. No migration
and no queue compatibility step. The code reads them through neutral names
(section 6.1). The API fields are renamed later through the API deprecation
cycle (signals-dpg#839), not in this change.

## 7. Oversized uploads and retention — decided: fix

Today `BULK_UPLOAD_MAX_BYTES` (default 10 MB, `apps/api/src/config.ts:135`)
stops an oversized CSV from being **processed**, not from being **uploaded**.
The web app does not check the size (it ignores the `max_bytes` it is sent),
the signed PUT URL does not limit the size, and only `/start` checks it
(`bulk-uploads.ts:464`). The rejected file is never deleted. For the
coordinator Upload is one click, so the error reads as "the upload failed"
while the file is stored.

Decision:

- **Refuse at upload.** The S3 provider issues POST upload instructions with
  a `content-length-range` up to `BULK_UPLOAD_MAX_BYTES`, so S3 refuses an
  oversized file before storing it. The web app follows the instructions.
- **Delete on rejection.** `/start` keeps its size check, and deletes the
  stored file whenever it rejects one (too large or empty), so nothing a
  coordinator was told "failed" stays in storage.
- **Check in the browser first.** The web app compares the file size with
  `max_bytes` from the create response before sending any bytes, and shows
  the size error. The reserved row stays `pending`, like any abandoned
  upload. The limit is only known after the create call, so no new API is
  added.
- **Retention for `bulk-uploads/`.** A lifecycle rule deletes objects under
  `bulk-uploads/` after a configurable number of days (a
  `global.bulkUploadRetentionDays`-style value in bluedots-automation, next to
  `campaignExportExpiryDays`). The default is to be confirmed. It applies to
  every instance, including on-prem MinIO.
- **Expired errors CSV.** Once retention has removed an upload's errors CSV,
  the errors download answers a clear not-found instead of handing out a
  link to a missing file.
- **`upload_url` during deprecation.** The create response's `upload` carries
  the size-limited POST. `upload_url` stays a working signed PUT URL with no
  size limit until it is removed (section 4.5).

## 8. Work items, order and deployment

The work is three sub-issues under #933. The aggregator-dpg part ships as
stacked draft PRs, one per block as `.claude/rules/pull-requests.md`
requires, merged bottom up:

| PR    | Issue | Block    | Delivers                                                                                                                                   |
| ----- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| #1057 | #1055 | packages | `packages/object-storage`: the contract, areas, config fields, S3 provider (`src/providers/s3/`), fake and shared test suite               |
| #1058 | #1055 | api      | The api on the package; the `upload` field on the create response; neutral names in the bulk-uploads store; the unused ETag finder removed |
| #1059 | #1055 | worker   | The worker on the package (CSV reads, errors CSV, campaign export)                                                                         |
| #1060 | #1055 | web      | The web app following the upload instructions (PUT from S3, so no behaviour change yet); this design and the plans; onboarding docs        |
| #1061 | #1056 | api      | S3 POST upload instructions with the size limit, delete on rejection at `/start`, the expired errors CSV answer                            |
| #1062 | #1056 | web      | The browser size check and its message                                                                                                     |

bluedots-automation#321 (item (c)) holds the lifecycle rule for
`bulk-uploads/` with the configurable retention, `POST` in the bucket CORS
methods (today `GET`, `HEAD`, `PUT`,
`opentofu/aws/modules/storage/variables.tf`), and the same on on-prem MinIO.

Order and deployment:

- **(a)** has no database migration, no env change and no helm change
  (`STORAGE_PROVIDER` defaults to `s3`). Web, api and worker deploy in any
  order: the web falls back to `upload_url` and `content_type` when `upload`
  is absent. Rollback is a plain image rollback.
- **(c)** is applied on each instance **before (b)** reaches it, because the
  browser's POST upload is blocked by CORS without it.
- **(b)** follows (a) and (c). It has no migration and no new env setting.
  On an instance, bluedots-automation#321 is applied first, then the web
  from #1060, then #1061.
- The Drizzle property rename (section 6.1) is code only: no migration and
  no deployment step.

## 9. Testing expectations

- The shared provider test suite passes for the fake and for the S3 provider
  against MinIO.
- Unit tests for the factory: default `s3`, unknown value fails, missing
  settings of the selected provider fail and name each setting.
- The create route returns `upload`; the web app uploads by following it, and
  falls back to `upload_url` and `content_type` without it.
- Existing bulk-upload route tests, worker job tests and campaign export
  tests pass unchanged in what they assert.
- For (b): an oversized file is refused by storage; a file rejected at
  `/start` is deleted; the browser shows the size error without uploading.
- A local run against MinIO of the three flows in section 2 still works end
  to end: browser upload, errors CSV download, campaign export link.

## 10. Left to the builder

- Exact method names and type names in the contract.
- Whether the health check is wired into the api's readiness probe.
- How the fake in `testing.ts` is shaped, as long as it passes the shared
  suite and both apps' tests can use it.

## 11. Future work

- Browser multipart upload for very large files.
- Malware scanning before public profile uploads (signals-dpg#566).
- The folder operations `list(area, prefix)` and `deleteByPrefix(area, prefix)`
  (section 4.3).
- A `public` area and a bucket per area (section 4.2).
