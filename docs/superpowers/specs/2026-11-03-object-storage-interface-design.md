# Object storage behind an interface — design

Issue: Blue-Dots-Economy/aggregator-dpg#933
Status: draft for review
Branch: `refactor/933-object-storage-interface` (cut from `origin/feature`)

## 1. Why

The aggregator can only store files in Amazon S3 or an S3-compatible store
such as MinIO. The AWS SDK is called directly from two places, so an adopter
whose cloud is not S3-like cannot run the aggregator without changing code.

This change puts object storage behind one interface. S3 becomes the first
(and, for now, only) storage provider behind it. Adding another provider later
must mean writing one new provider file and changing a config value, with no
change to the features that store files.

## 2. What uses object storage today

Three features, spread across two apps:

| Feature | What is stored | Operations used | Where |
|---|---|---|---|
| Bulk CSV upload | The CSV a coordinator uploads | Pre-signed **upload** URL (the browser PUTs the file straight to storage); **HEAD** (exists, size, ETag) to confirm the upload; **streamed read** in the worker | `apps/api/src/routes/bulk-uploads.ts` (create, `/start`), `apps/web/src/services/onboarding.service.ts` (browser PUT), `apps/worker/src/jobs/bulk-file-process.ts` |
| Bulk upload errors CSV | The report of rejected rows | **Write** (worker); pre-signed **download** URL (api) | `apps/worker/src/jobs/bulk-finalise.ts`, `apps/api/src/routes/bulk-uploads.ts` (errors download) |
| Campaign participant export | The PII export a coordinator requests | **Write**; pre-signed **download** URL sent by email (valid 24 h by default) | `apps/worker/src/services/campaign-process/index.ts`, `apps/worker/src/jobs/campaign-process.ts` |

The S3 code itself lives in two near-identical files, each building its own
S3 clients from its own copy of the `S3_*` config:

- `apps/api/src/services/object-storage/index.ts` — `signBulkUploadUrl`,
  `headObject`, `signErrorsCsvDownloadUrl`, and an unused `putObject`.
- `apps/worker/src/object-storage.ts` — `getCsvStream`, `putObject`,
  `signExportDownloadUrl`.

Both keep two S3 clients: an internal one (`S3_ENDPOINT`) for server-side
calls, and a presigner (`S3_PUBLIC_ENDPOINT`, falling back to `S3_ENDPOINT`)
so signed URLs point at a host the browser can reach.

Nothing else stores files. Signals-DPG has no storage code. The Signals
`s3-export` job and the aggregator `/v1/campaign/dump` route are being retired
(replaced by `platform-sync`, which writes straight to the Campaign Manager
database) and are out of scope.

## 3. Goals, non-goals, anti-goals

**Goals**
- One object-storage interface shared by the api and the worker.
- S3 implemented as a provider behind it, behaving exactly as today.
- A `STORAGE_PROVIDER` setting chooses the provider. Switching to another
  provider, once one exists, is a config change only.
- The features above depend only on the interface, never on a storage SDK.
- The way to write a new provider is obvious from the code: one file
  implementing the interface, plus one case in the factory.

**Non-goals**
- Shipping any provider other than S3.
- Changing how any feature behaves for users, including the browser
  uploading straight to storage. The only user-visible difference is the
  reworded upload error text (section 7.1).
- Changing deployment config (helm, docker-compose, `.env.example` values)
  beyond what is listed in section 6.

**Anti-goals** (this would be a failure even if it technically works)
- Any behaviour change for existing S3/MinIO deployments, including on
  upgrade: same env vars, same object keys, same URLs, same limits.
- The interface leaking S3 concepts (bucket, ETag quoting, path style,
  `Command` objects) to callers.
- Two copies of the storage code surviving the change.

## 4. Design

### 4.1 A shared package: `@aggregator-dpg/object-storage`

A new workspace package under `packages/object-storage`, scaffolded from
`packages/_template` and used by both `apps/api` and `apps/worker`. Its shape
follows the existing `@aggregator-dpg/mailer` package, which solves the same
problem for email (`MailerAdapter` contract, `smtp` and `ses` providers,
`MAIL_PROVIDER` to choose, a fake for tests), and the repo rules in
`.claude/rules/base-class-pattern.md` and `.claude/rules/interfaces.md`.
It differs from the mailer in two ways: it takes parsed config from the apps
instead of reading `process.env`, and it fails at startup, not on first use.

| File | Subpath export | Purpose |
|---|---|---|
| `src/interface.ts` | `./interface` | `ObjectStorageBase` abstract class, input/output types |
| `src/config.ts` | `./config` | Storage config field-set (`STORAGE_PROVIDER` + each provider's settings), spread into both apps' config schemas |
| `src/s3.ts` | none | `S3ObjectStorage extends ObjectStorageBase`; all `@aws-sdk/*` imports live here only |
| `src/index.ts` | `.` | `getObjectStorage()` factory: provider choice, process-wide singleton, test override |
| `src/testing.ts` | `./testing` | In-memory fake extending `ObjectStorageBase`, for unit tests |

Provider files are not exported, so apps cannot import a provider directly:
they reach a provider only through `getObjectStorage()`. The package's
`exports` map enforces this; `pnpm dep-check` scans `packages/` only, so it
does not need to change.

The `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` dependencies move
from `apps/api` and `apps/worker` into this package.

### 4.2 The interface

`ObjectStorageBase` is an abstract class (repo rule: contracts are abstract
classes, not TS interfaces). Every method is abstract and returns
`Promise<Result<T, BaseError>>` from `@aggregator-dpg/shared-primitives`.
Generic, storage-neutral operations. Callers decide object keys and TTLs;
the provider knows nothing about bulk uploads or campaigns.

| Operation | Purpose | Used by |
|---|---|---|
| Create upload URL (key, content type, expiry) → URL, expiry time, headers the browser must send | Lets a browser upload one object directly. The content type is enforced by the signature. The headers carry what the provider requires on the PUT (S3: `Content-Type`; Azure: also `x-ms-blob-type: BlockBlob`). | bulk upload create |
| Create download URL (key, expiry, download filename, content type) → URL, expiry time | Lets a browser or email recipient download one object, served as an attachment with the given filename. | errors CSV, campaign export |
| Stat (key) → `{ size, fingerprint }` or "not found" | Confirms an upload landed, checks its size, captures a content fingerprint. "Not found" is a success value; failures are error results. | bulk upload `/start` |
| Open read stream (key) → Node `Readable` | Streams an object without loading it into memory. The caller owns the stream. | bulk file process |
| Put (key, bytes, content type) | Writes an object, with a bounded per-call timeout. | errors CSV, campaign export |

Notes on the contract:
- **Fingerprint** replaces "ETag" in the interface. For S3 it is today's ETag
  with the quotes stripped, so the values stored in the database do not
  change. It is compared only on the same upload row (`markUploaded` treats a repeat
  `/start` with the same value as a no-op), so values from different
  providers never meet.
- **Not carried over**: the comment in today's api storage module saying the
  size is checked at `/complete`; the route is `/start`.
- **Two endpoints** stay a provider concern. The S3 provider keeps the
  internal client for server-side calls and the public presigner for URLs.
- **Timeouts and retries** stay as today for S3: 5 s connect timeout, 3
  attempts, 60 s timeout on writes, no total timeout on streamed reads.
- **Errors**: providers never throw across the boundary. A transport or
  provider failure is returned as an `UpstreamError`; a bad input as a
  `ValidationError`. Callers map an error result to exactly today's behaviour:
  in the bulk-upload routes a storage failure today is uncaught and answers
  **500 `INTERNAL`** (`apps/api/src/errors/serialize.ts`), and it stays 500;
  worker jobs still fail and retry where they do now. Changing the api to a
  503 would be a behaviour change and is out of scope. "Not found" on stat is a success value, not an
  error.

### 4.3 Choosing the provider: `STORAGE_PROVIDER`

- New optional setting `STORAGE_PROVIDER`, default `s3`, read by both the
  api and the worker.
- The storage settings are declared once, in the package's `./config`
  field-set, and spread into both apps' config schemas, the same way
  `signalStackConfigFields` from `@aggregator-dpg/shared-primitives/config`
  is today. Keeping it in the storage package means a new provider touches
  only this package. This removes the duplicate
  `S3_*` definitions in `apps/api/src/config.ts` and
  `apps/worker/src/config.ts`, and the apps pass the parsed values to the
  factory.
- `s3` builds the S3 provider from the existing `S3_*` settings, which keep
  their current names and meanings: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`,
  `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`. Leaving the keys blank still falls back to the
  default AWS credential chain (IAM role / IRSA).
- An unknown value fails at startup with a clear message, never at the first
  upload.
- Each provider owns its own settings, named with its own prefix (for example
  `AZURE_STORAGE_*` for a future Azure provider).
- **Required-ness depends on the selected provider.** In the schema every
  provider's settings are optional on their own. A check on the whole config
  then requires the settings of the provider named in `STORAGE_PROVIDER`
  only, and fails startup naming each missing one. Settings of providers
  that are not selected are ignored, so an S3 deployment never needs
  `AZURE_STORAGE_*` and an Azure deployment never needs `S3_*`.
- For `s3` the existing defaults and fallbacks are kept exactly:
  `S3_REGION` defaults to `us-east-1`, `S3_BUCKET` to
  `aggregator-bulk-uploads`, `S3_FORCE_PATH_STYLE` to `true`;
  `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` and the two keys stay optional. So no
  existing deployment gains a newly required setting.

### 4.4 What stays in the apps

- **Object keys** are still built by the features:
  `bulk-uploads/<aggregatorId>/<uploadId>/raw.csv`,
  `bulk-uploads/<uploadId>/errors.csv`,
  `campaign-exports/<orgId>/<jobId>.csv`.
- **TTLs and limits** stay in each app's config: `BULK_UPLOAD_URL_TTL_SECONDS`,
  `BULK_UPLOAD_MAX_BYTES` (api) and `EXPORT_URL_TTL_SECONDS` (worker).
- **Response shapes** of the bulk-upload API are unchanged except for one
  added field on the create response, `upload_headers` (an object of header
  name → value the browser must send on the PUT). For S3 it holds only
  `Content-Type`, which equals the existing `content_type` field, so S3
  behaviour is identical. The existing fields stay.

### 4.5 How a new provider is written

This is the recipe the code should make obvious (shown here for a future
Azure Blob provider; not part of this change):

1. Add `src/<provider>.ts` with a class extending `ObjectStorageBase`, using the provider's
   own SDK. Upload/download URLs map to the provider's equivalent of
   pre-signed URLs (Azure: SAS URLs; GCS: signed URLs).
2. Add the SDK as a dependency of `@aggregator-dpg/object-storage` only.
3. Add the provider's settings to `src/config.ts`, and one case to the
   factory in `src/index.ts` that fails fast at startup when a required
   setting is missing.
4. Add unit tests for the provider.
5. Document the new `STORAGE_PROVIDER` value and its settings in
   `.env.example`.

Things every provider must also handle outside the code, which the S3
deployment handles today:
- **CORS** on the container/bucket, so the browser can PUT directly.
- **Expiry of export files** (S3 uses a bucket lifecycle rule tied to
  `global.campaignExportExpiryDays`); the download URL TTL is only the link.

A provider that cannot issue pre-signed URLs (for example plain disk) cannot
fit this interface as is; it would need new upload/download API routes and is
deliberately not designed here.

## 5. Changes by area

| Area | Change |
|---|---|
| `packages/object-storage` (new) | Interface, S3 provider, factory, test fake, unit tests |
| `apps/api` | `routes/bulk-uploads.ts` calls the interface; `services/object-storage/` removed; `config.ts` spreads the shared storage fields instead of its own `S3_*`; AWS S3 deps removed from `package.json` |
| `apps/worker` | `jobs/bulk-file-process.ts`, `jobs/bulk-finalise.ts`, `jobs/campaign-process.ts`, `services/campaign-process` call the interface; `src/object-storage.ts` removed; `config.ts` spreads the shared storage fields; AWS S3 deps removed from `package.json` |
| `apps/web` | The browser PUT sends the headers from `upload_headers` (falling back to `content_type` when the field is absent, so web and api deploy in either order); the upload error text is reworded (section 7.1). No visible change otherwise. |
| Tests | Tests that mock the two old storage modules switch to the package's fake; existing route and job tests keep their assertions |
| Config / docs | `STORAGE_PROVIDER` added to `.env.example`, `apps/api/.env.example`, `apps/worker/.env.example`, and the env docs; helm and docker-compose need no change because the default is `s3` |
| Database | None (unless the decision in section 7.2 chooses to rename the columns) |

## 6. Deploying it

With the contract names kept (section 7.2 "Keep"):
- **No database migration.**
- **No env or helm change.** `STORAGE_PROVIDER` is unset everywhere and
  defaults to `s3`.
- **No ordering constraint** between api, worker and web (the web falls
  back when `upload_headers` is absent); api and worker talk to the same
  bucket with the same keys as before.
- Rollback is a plain image rollback.

## 7. The "S3" names outside the S3 provider

After the interface is in, the word "S3" still appears in names outside the
S3 provider. The stored values (`bulk-uploads/...`) are already
provider-neutral; only the names say S3. They fall into two groups.

`S3_*` env vars are not renamed in either group: they configure the S3
provider specifically, and keep their names.

### 7.1 Renamed in this change (no migration, no compatibility step)

These are internal or plain text. Renaming them changes no stored data and no
contract, so they are part of this change:

| What | Today | After |
|---|---|---|
| Upload error a coordinator can see | `S3 PUT failed (<status>): <body>` (`apps/web/src/services/onboarding.service.ts:263`, shown by `CSVUpload.tsx`) | Storage-neutral wording, e.g. `File upload failed (<status>)` |
| API route descriptions | "pre-signed S3 GET URL" and similar (`routes/bulk-uploads.ts`, regenerated into `openapi.json`) | "pre-signed download URL" and similar. Descriptions only; field names unchanged. |
| Log fields and reasons | `s3_key`, `s3_object_missing`, `sub: 's3.put'` | `storage_key`, `storage_object_missing`, `storage.put` |
| Code names | `s3Key`, `s3Etag`, `errorsCsvS3Key` in the bulk-uploads store, route and worker jobs | `storageKey`, `contentFingerprint`, `errorsCsvStorageKey`. The Drizzle fields keep mapping to the existing column names (e.g. `storageKey: text('s3_key')`), so the database is untouched. |
| Dead code | `findByAggregatorAndEtag` and the `DUPLICATE_ETAG` error, unused since migration 0012 dropped the unique index they relied on (only a test stub calls the finder) | Deleted |
| Docs | `docs/onboarding-design.md`, `docs/onboarding-implementation.md` | Neutral wording |

Before release, check that no log-based alert or dashboard filters on the
old log field names.

### 7.2 Open decision — the three contract names

These three names are contracts with stored data or with callers, so
renaming them needs a migration or a compatibility step. **Reviewers: please
choose keep or rename for each row (they are independent).**

| Name | What it is | Rename means |
|---|---|---|
| Database columns `bulk_uploads.s3_key` (NOT NULL), `s3_etag`, `errors_csv_s3_key` | Where each uploaded CSV and its errors CSV live in storage, and the upload's fingerprint. The files themselves are in storage; these columns hold only their location. | A migration (see below) |
| Queue job field `s3Key` (`packages/queue/src/index.ts`, bulk file job) | Tells the worker which object to read | Worker accepts both names for one release |
| API response fields `s3_key`, `errors_csv_s3_key` (`routes/bulk-uploads.ts`, `openapi.json`) | Returned to the web app and any other caller | Both names returned for one release |

**Keep**: no work, no migration. "s3" stays visible in these column and field
names on any deployment; behaviour is unaffected.

**Rename** (about one more day for all three):

1. **Database**: a Drizzle migration renaming the three columns to
   `storage_key`, `content_fingerprint`, `errors_csv_storage_key`. Postgres
   renames are metadata-only (instant, no table rewrite), but code still
   running against the old names fails while the rename is live. With
   today's single api replica, the old pod errors on bulk-upload requests for
   the seconds between the migration and the new pod becoming ready. To avoid
   even that window, split it into two releases: release A adds the new
   columns and writes both, release B switches reads and drops the old
   columns.
2. **Queue field**: jobs already waiting in Redis when the new worker starts
   still carry `s3Key`. The new worker accepts both names for one release;
   the old name is dropped in a later release, once no old jobs remain.
   Deploy the worker before or together with the api.
3. **API fields**: where they are and who reads them today:

   | Endpoint | Field | Read by |
   |---|---|---|
   | `POST /v1/bulk-uploads` (create) | `s3_key` (path of the uploaded CSV) | Nobody: typed in `apps/web/src/services/onboarding.service.ts` but never used |
   | `GET /v1/bulk-uploads`, `GET /v1/bulk-uploads/:id` | `errors_csv_s3_key` (path of the errors CSV, or null) | The web upload screen: shows the "download errors" button only when it is set (`CSVUpload.tsx:380`) |
   | `GET /v1/bulk-uploads/:id/errors.csv` | `s3_key` (path of the errors CSV) | Nobody: typed in the web app but never used |

   The web BFF routes (`apps/web/src/app/api/bulk-uploads/**`) pass the API
   responses through unchanged. Outside this repo, `bluedots-e2e` has
   generated client types (no test uses the fields) and `bluedots-docs`
   publishes a copy of `openapi.json`. The API is also reachable directly
   through the Kong ingress (`v1/bulk-uploads` rate-limit group in
   `bluedots-automation`), so an unknown caller with a coordinator token
   cannot be ruled out.

   Rename steps: the api returns both the old and the new field for one
   release (old marked deprecated in `openapi.json`); the web app moves to
   the new field (it decides whether to show the errors-download button from
   `errors_csv_s3_key`, `CSVUpload.tsx:380`); the old fields are removed in a
   later release. Web and api can then deploy in any order.

## 8. Open question — oversized uploads stay in storage

Today `BULK_UPLOAD_MAX_BYTES` (default 10 MB, `apps/api/src/config.ts:135`)
stops an oversized CSV from being **processed**, not from being **uploaded**:

- The web app does not check the file size before uploading. The create
  response returns `max_bytes`, but `apps/web` does not use it.
- The signed upload URL does not limit the size, so storage accepts any file
  up to its own limit (5 GB for a single S3 PUT).
- Only `/start` checks the size, by reading the stored file's details
  (`bulk-uploads.ts:464`). An oversized file is rejected there and never
  queued, so the worker never reads it.
- Nothing deletes the rejected file. No code deletes objects, and the bucket
  lifecycle rule only expires `campaign-exports/`
  (`bluedots-automation/opentofu/aws/modules/storage/main.tf`), so
  `bulk-uploads/` files are kept indefinitely.

For the coordinator, Upload is one click, so the error reads as "the upload
failed", while the file is in fact stored.

**Reviewers: please decide** whether keeping the uploaded file is intended,
or whether large uploads should be blocked before they reach storage (and
rejected files removed). This change keeps today's behaviour either way; any
fix is separate work.

## 9. Testing expectations

- Unit tests for the S3 provider (request shapes, not-found handling, ETag
  quote stripping, public vs internal endpoint for signed URLs, credentials
  vs default chain) and for the factory (default `s3`, unknown value fails).
- The create route returns `upload_headers`, and the web upload sends those
  headers (and falls back to `content_type` without them).
- Existing bulk-upload route tests, worker job tests and campaign export
  tests pass unchanged in what they assert.
- A local run against MinIO of the three flows in section 2 still works end
  to end: browser upload, errors CSV download, campaign export link.

## 10. Left to the builder

- Exact method names and type names in the interface.
- How the fake in `testing.ts` is shaped, as long as both apps' tests can use
  it.
