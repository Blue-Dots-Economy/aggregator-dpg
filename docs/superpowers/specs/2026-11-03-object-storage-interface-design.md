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
  uploading straight to storage.
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
| Create upload URL (key, content type, expiry) → URL, expiry time | Lets a browser upload one object directly. The content type is enforced by the signature. | bulk upload create |
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
  `AZURE_STORAGE_*` for a future Azure provider). Settings for providers that
  are not selected are ignored.

### 4.4 What stays in the apps

- **Object keys** are still built by the features:
  `bulk-uploads/<aggregatorId>/<uploadId>/raw.csv`,
  `bulk-uploads/<uploadId>/errors.csv`,
  `campaign-exports/<orgId>/<jobId>.csv`.
- **TTLs and limits** stay in each app's config: `BULK_UPLOAD_URL_TTL_SECONDS`,
  `BULK_UPLOAD_MAX_BYTES` (api) and `EXPORT_URL_TTL_SECONDS` (worker).
- **Response shapes** of the bulk-upload API are unchanged.

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
| `apps/web` | None |
| Tests | Tests that mock the two old storage modules switch to the package's fake; existing route and job tests keep their assertions |
| Config / docs | `STORAGE_PROVIDER` added to `.env.example`, `apps/api/.env.example`, `apps/worker/.env.example`, and the env docs; helm and docker-compose need no change because the default is `s3` |
| Database | None (unless the naming decision in section 7 chooses to rename) |

## 6. Deploying it

With names kept as they are (section 7, option 1):
- **No database migration.**
- **No env or helm change.** `STORAGE_PROVIDER` is unset everywhere and
  defaults to `s3`.
- **No ordering constraint** between api and worker; both talk to the same
  bucket with the same keys as before.
- Rollback is a plain image rollback.

## 7. Open decision — keep the S3 names or rename them

After this change the word "S3" still appears in names outside the S3
provider. The stored values (`bulk-uploads/...`) are already
provider-neutral; only the names say S3. **Reviewers: please choose one
option.**

Where the names are:

| Layer | Names today | Where |
|---|---|---|
| Database columns | `bulk_uploads.s3_key` (NOT NULL), `bulk_uploads.s3_etag`, `bulk_uploads.errors_csv_s3_key` | `packages/db-schema/src/schema.ts` |
| Code | `s3Key`, `s3Etag`, `errorsCsvS3Key` | bulk-uploads store (`interface.ts`, `postgres.ts`), `routes/bulk-uploads.ts`, worker jobs |
| Queue job payload | `s3Key` | `packages/queue/src/index.ts` (bulk file job) |
| API responses | `s3_key`, `errors_csv_s3_key` | `routes/bulk-uploads.ts`, `openapi.json`; read by `apps/web/src/services/onboarding.service.ts` and `CSVUpload.tsx` |
| Env vars | `S3_*` | both apps, `.env.example` files, docker-compose, `bluedots-automation` helm |
| Docs and logs | `s3_key` log fields, `docs/onboarding-*.md` | — |

### Option 1 — keep the names (recommended for this issue)

Everything goes through the interface; the existing names are only labels.
A column called `s3_key` holds a storage key whatever the provider is, and
the S3 provider keeps reading `S3_*` settings, which is correct because they
are S3 settings.

- Cost: none beyond section 5.
- Migration: none. Deploy as in section 6.
- Downside: a reader on a non-S3 deployment sees "s3" in column and field
  names; it is cosmetic.

### Option 2 — rename to neutral names

Suggested names: `storage_key`, `content_fingerprint`, `errors_csv_storage_key`
(and the matching `storageKey`, `contentFingerprint`, `errorsCsvStorageKey` in
code). `S3_*` env vars are **not** renamed under either option: they configure
the S3 provider specifically.

Extra work (about one more day):

1. **Database**: a Drizzle migration renaming the three columns. Postgres
   renames are metadata-only (instant, no table rewrite), but code still
   running against the old names fails while the rename is live.
2. **Code**: rename across the store, route, worker jobs and tests.
   `findByAggregatorAndEtag` and the `DUPLICATE_ETAG` error are dead since
   migration 0012 dropped the unique index they relied on (only a test stub
   calls the finder); they would be deleted rather than renamed.
3. **Queue payload**: the bulk file job carries `s3Key`. Jobs already queued
   in Redis when the new worker starts still carry the old field, so the new
   worker must accept both `s3Key` and the new name for one release, then the
   old name is dropped in a later release.
4. **API responses**: `s3_key` and `errors_csv_s3_key` are part of the public
   contract in `openapi.json`. To avoid breaking any caller, the api returns
   both the old and the new field for one release (old marked deprecated),
   the web app moves to the new field, and the old field is removed later.
5. **Docs and logs** updated.

Deploy order for option 2:
- **Before or with the new api**: run the column-rename migration. With
  today's single api replica, the old pod errors on bulk-upload requests for
  the seconds between the migration and the new pod becoming ready. To avoid
  even that window, split it: release A adds the new columns and writes both
  (or adds a view/generated column), release B switches reads and drops the
  old columns.
- **Worker**: deploy the new worker with the dual-read of the queue payload
  before or together with the api; drop the old payload field one release
  later, once the queue holds no old jobs.
- **Web and api** ship together; the old API fields are removed one release
  after that.

## 8. Testing expectations

- Unit tests for the S3 provider (request shapes, not-found handling, ETag
  quote stripping, public vs internal endpoint for signed URLs, credentials
  vs default chain) and for the factory (default `s3`, unknown value fails).
- Existing bulk-upload route tests, worker job tests and campaign export
  tests pass unchanged in what they assert.
- A local run against MinIO of the three flows in section 2 still works end
  to end: browser upload, errors CSV download, campaign export link.

## 9. Left to the builder

- Exact method names and type names in the interface.
- How the fake in `testing.ts` is shaped, as long as both apps' tests can use
  it.
