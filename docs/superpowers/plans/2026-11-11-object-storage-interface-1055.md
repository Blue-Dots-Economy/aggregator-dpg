# Object storage interface (#1055) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all object storage in the api and worker behind one shared `@aggregator-dpg/object-storage` package, with S3 as the only provider and no behaviour change for users or deployments.

**Architecture:** A new workspace package holds an abstract `ObjectStorageBase`, two areas, a zod config field-set, the S3 provider, an in-memory fake and one shared contract test suite. The api and worker initialise it once at startup and call only the interface. Internal "S3" names are renamed; the database columns, the queue field and the API field names are kept.

**Tech Stack:** TypeScript (ESM), pnpm + Turbo, zod, Fastify (api), BullMQ (worker), Next.js (web), AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-object-storage-interface-design.md` (sections 4, 5, 6, 8 item (a)).

## Global Constraints

- No code comments; TSDoc on public classes and functions only, one summary line plus `@param`/`@returns`/`@throws` when not obvious.
- Contracts are abstract classes, never TS interfaces (`.claude/rules/base-class-pattern.md`).
- Operations return `Promise<Result<T, BaseError>>` (`@aggregator-dpg/shared-primitives/result`, `/errors`); never throw across the package boundary.
- The package depends on no workspace package except `@aggregator-dpg/shared-primitives`.
- `STORAGE_PROVIDER` default `s3`. `S3_*` names, meanings and defaults unchanged: `S3_REGION`=`us-east-1`, `S3_BUCKET`=`aggregator-bulk-uploads`, `S3_FORCE_PATH_STYLE`=`true`; `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` optional; blank keys use the default AWS credential chain.
- S3 timeouts: 5 000 ms connect, 3 attempts, 60 000 ms on buffered `put`, none on streamed reads and streamed `put`.
- Full object keys stay exactly: `bulk-uploads/<aggregatorId>/<uploadId>/raw.csv`, `bulk-uploads/<uploadId>/errors.csv`, `campaign-exports/<orgId>/<jobId>.csv`.
- Storage failures in bulk-upload routes still answer 500 `INTERNAL`.
- Kept names: columns `s3_key`, `s3_etag`, `errors_csv_s3_key`; queue field `BulkFileProcessJob.s3Key`; API fields `s3_key`, `errors_csv_s3_key`.
- Tests: Vitest with `--pool=forks --maxWorkers=2`; turbo with `--concurrency=1`.
- `.env*` files are write-blocked for the agent: hand the exact lines to the user.
- Each PR at most 18 changed files (lockfile included), opened as a draft, stacked on the previous one.

## PR stack

| PR | Branch | Base | Tasks | Files |
|---|---|---|---|---|
| 1 | `refactor/933-object-storage-interface` | `feature` | Tasks 0–4: spec + plans, package, web follows upload instructions | 18 |
| 2 | `refactor/1055-2-api-on-storage` | PR 1 | Tasks 5–6: api on the package, neutral code names, dead code | 18 |
| 3 | `refactor/1055-3-worker-on-storage` | PR 2 | Task 7: worker on the package, env examples, onboarding docs | 18 |

PR titles: `refactor(object-storage): #1055 <summary>`. Bodies: PRs 1–2 say `Part of #1055`; PR 3 says `Closes #1055`. #1056 is one PR stacked on PR 3 (separate plan).

PR 1 ships the web change before the api change on purpose: the web app follows the `upload` field when present and falls back to `upload_url` and `content_type` when not, so it is safe on its own.

## Review Focus

1. A stored key that is not inside the expected area (the `'pending'` placeholder left when signing failed, or a hand-edited row) must be treated as "file not found" at `/start` (400 "CSV upload not found"), never a 500 — Task 5.
2. Storage unreachable at `/start` must still answer 500 and leave the row `pending` so the user can retry — Task 5.
3. Deleting an object that does not exist must succeed on every provider — Task 2 (contract suite).
4. A `Readable` body that errors halfway through `put` must return an `UpstreamError`, not hang or throw — Task 3.
5. Signed URLs must use `S3_PUBLIC_ENDPOINT` while server-side calls use `S3_ENDPOINT` (MinIO in docker) — Task 3.

---

### Task 0: Bring the spec branch up to date and correct the browser size-check placement

**Files:**
- Modify: `docs/superpowers/specs/2026-11-03-object-storage-interface-design.md` (section 7, "Check in the browser first")
- Add: `docs/superpowers/plans/2026-11-11-object-storage-interface-1055.md`, `docs/superpowers/plans/2026-11-11-oversized-bulk-uploads-1056.md`

- [ ] **Step 1:** `git fetch origin && git rebase origin/feature` on `refactor/933-object-storage-interface` (docs-only so far, no PR yet), then `git push --force-with-lease`.
- [ ] **Step 2:** In spec section 7 replace the browser bullet with: the web app compares the file size with `max_bytes` from the create response before sending any bytes, and shows the size error; the reserved row stays `pending` like any abandoned upload. (The limit is only known after the create call; no new API is added.)
- [ ] **Step 3:** Commit `docs(object-storage): #933 add the #1055 and #1056 implementation plans and place the browser size check after the create call`.

### Task 1: Package skeleton, contract, areas and config

**Files:**
- Create: `packages/object-storage/package.json`, `packages/object-storage/tsconfig.json`, `packages/object-storage/vitest.config.ts` (copy from `packages/_template`, adjust name/exports)
- Create: `packages/object-storage/src/interface.ts`, `src/areas.ts`, `src/config.ts`
- Test: `packages/object-storage/src/__tests__/index.test.ts` (shared with Tasks 2–3)

**Interfaces:**
- Produces (`./interface`):
  ```ts
  export type StorageArea = 'bulk-uploads' | 'exports';
  export interface ObjectRef { area: StorageArea; key: string }        // key is relative to the area prefix
  export interface UploadInstructions { method: 'PUT' | 'POST'; url: string; headers: Record<string, string>; formFields: Record<string, string>; expiresAt: string }
  export interface CreateUploadInput { ref: ObjectRef; contentType: string; maxBytes: number; expiresInSeconds: number }
  export interface CreateDownloadInput { ref: ObjectRef; expiresInSeconds: number; filename: string; contentType: string }
  export interface DownloadUrl { url: string; expiresAt: string }
  export interface ObjectStat { size: number; fingerprint: string }
  export interface PutInput { ref: ObjectRef; body: Buffer | Readable; contentType: string }
  export abstract class ObjectStorageBase {
    abstract createUpload(input: CreateUploadInput): Promise<Result<UploadInstructions, BaseError>>;
    abstract createDownloadUrl(input: CreateDownloadInput): Promise<Result<DownloadUrl, BaseError>>;
    abstract stat(ref: ObjectRef): Promise<Result<ObjectStat | null, BaseError>>;
    abstract openReadStream(ref: ObjectRef): Promise<Result<Readable | null, BaseError>>;
    abstract put(input: PutInput): Promise<Result<void, BaseError>>;
    abstract delete(ref: ObjectRef): Promise<Result<void, BaseError>>;
    abstract checkHealth(): Promise<Result<void, BaseError>>;
  }
  ```
- Produces (`./areas`): `AREAS: Readonly<Record<StorageArea, { prefix: string; visibility: 'private' }>>` with `bulk-uploads` → `bulk-uploads/`, `exports` → `campaign-exports/`; `toStoredKey(ref: ObjectRef): string` (prefix + key); `fromStoredKey(area: StorageArea, stored: string): Result<ObjectRef, ValidationError>` (error when `stored` does not start with the prefix or the remainder is empty).
- Produces (`./config`): `storageConfigFields` (zod shape: `STORAGE_PROVIDER: z.enum(['s3']).default('s3')` plus the seven `S3_*` fields exactly as in `apps/api/src/config.ts:117-133`); `type StorageConfig` = the parsed object of those fields.

- [ ] **Step 1: Write failing tests** in `index.test.ts`: `toStoredKey({area:'bulk-uploads', key:'a/b/raw.csv'})` → `'bulk-uploads/a/b/raw.csv'`; `toStoredKey({area:'exports', key:'o/j.csv'})` → `'campaign-exports/o/j.csv'`; `fromStoredKey('bulk-uploads','bulk-uploads/x/errors.csv')` → ok `{area:'bulk-uploads', key:'x/errors.csv'}`; `fromStoredKey('bulk-uploads','pending')`, `('bulk-uploads','campaign-exports/x')` and `('bulk-uploads','bulk-uploads/')` → `ValidationError`; `z.object(storageConfigFields).parse({})` gives `STORAGE_PROVIDER:'s3'`, `S3_REGION:'us-east-1'`, `S3_BUCKET:'aggregator-bulk-uploads'`, `S3_FORCE_PATH_STYLE:true`; `parse({STORAGE_PROVIDER:'azure'})` throws.
- [ ] **Step 2:** `pnpm install && pnpm --filter @aggregator-dpg/object-storage test -- --pool=forks --maxWorkers=2` → FAIL (modules missing).
- [ ] **Step 3:** Implement `interface.ts`, `areas.ts`, `config.ts`. Package `exports`: `.`, `./interface`, `./areas`, `./config`, `./testing`, `./contract-suite` (no export for `s3`). Dependencies: `@aggregator-dpg/shared-primitives`, `zod`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` (same `^3.1151.0` line as the apps); devDependencies as `_template` plus `@types/node`.
- [ ] **Step 4:** Re-run → PASS. `pnpm --filter @aggregator-dpg/object-storage typecheck` → no errors.
- [ ] **Step 5:** Commit `feat(object-storage): #1055 add the storage contract, areas and config fields`.

### Task 2: In-memory fake and the shared contract suite

**Files:**
- Create: `packages/object-storage/src/testing.ts`, `src/contract-suite.ts`
- Test: `packages/object-storage/src/__tests__/index.test.ts` (adds the fake's contract run)

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `class FakeObjectStorage extends ObjectStorageBase` (`./testing`) with test helpers `seed(ref, bytes: Buffer, contentType?)`, `read(ref): Buffer | undefined`, `failNext(op: keyof ObjectStorageBase, error: BaseError)`; upload instructions `{method:'PUT', url:'fake://<storedKey>', headers:{'Content-Type': contentType}, formFields:{}}`; fingerprint = sha256 hex of the bytes.
- Produces: `runObjectStorageContract(name: string, make: () => Promise<{ storage: ObjectStorageBase; seed(ref: ObjectRef, bytes: Buffer): Promise<void> }>)` (`./contract-suite`), a Vitest `describe` block.

- [ ] **Step 1: Write the suite** and call `runObjectStorageContract('fake', …)` from `index.test.ts`. Cases, against `{area:'bulk-uploads'}` keys unless named: `stat` of a missing ref → ok `null`; `openReadStream` of a missing ref → ok `null`; `put` Buffer then `stat` → `size` equals byte length and `fingerprint` non-empty; `put` Readable of 3 chunks then `openReadStream` → same bytes; same bytes put twice → same fingerprint, different bytes → different fingerprint; `delete` then `stat` → `null`; `delete` of a missing ref → ok; `createDownloadUrl` → ok with `expiresAt` within `expiresInSeconds` of now; `createUpload` → ok, `method` is `PUT` or `POST`, `headers['Content-Type'] ?? formFields['Content-Type']` equals the content type; `put` to area `exports` then `stat` on the same key in area `bulk-uploads` → `null`; `checkHealth` → ok.
- [ ] **Step 2:** Run → FAIL (fake missing).
- [ ] **Step 3:** Implement `FakeObjectStorage` with a `Map<string, {bytes, contentType}>` keyed by `toStoredKey(ref)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(object-storage): #1055 add the in-memory fake and the shared provider contract suite`.

### Task 3: S3 provider and the factory

**Files:**
- Create: `packages/object-storage/src/s3.ts`, `src/index.ts`
- Test: `packages/object-storage/src/__tests__/s3.test.ts` (unit tests and the MinIO contract run), extend `src/__tests__/index.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (`.`): `initObjectStorage(cfg: StorageConfig): ObjectStorageBase` (builds the provider once; `STORAGE_PROVIDER` is already validated by the schema), `getObjectStorage(): ObjectStorageBase` (throws `ConfigError` "object storage not initialised" if `init` was not called), `_setObjectStorage(s: ObjectStorageBase | null): void`; re-exports the `./interface` and `./areas` symbols.
- `S3ObjectStorage` (not exported from the package): constructor `(cfg: StorageConfig)`; internal client on `S3_ENDPOINT`, presigner client on `S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT`; `createUpload` → `PUT` instructions signed with `ContentType` (`maxBytes` not enforced yet — #1056); `createDownloadUrl` signs `GetObject` with `ResponseContentDisposition: attachment; filename="<filename>"` and `ResponseContentType`; `stat` uses `HeadObject`, maps `NotFound`/`NoSuchKey` to `null`, strips quotes from the ETag; `openReadStream` maps `NoSuchKey` to `null`; `put` Buffer → `PutObject` with a 60 s abort signal, Readable → `@aws-sdk/lib-storage` `Upload`; `delete` → `DeleteObject`; `checkHealth` → `HeadBucket`. Every SDK failure → `err(new UpstreamError('object storage <op> failed', { cause }))`.

- [ ] **Step 1: Write failing unit tests** in `s3.test.ts` with `vi.mock('@aws-sdk/client-s3')` capturing commands: `stat` returns `{size:10, fingerprint:'abc'}` for ETag `"abc"`, `null` for an error named `NotFound` and for `NoSuchKey`, `UpstreamError` for `TimeoutError`; `createUpload` URL host is `S3_PUBLIC_ENDPOINT`'s host while `stat` is sent through the `S3_ENDPOINT` client; `createDownloadUrl` signs `ResponseContentDisposition: 'attachment; filename="errors.csv"'`; `put` Buffer passes an `abortSignal`; `put` with a Readable that emits `error` → `UpstreamError`; client built without `credentials` when the keys are blank, with them when both are set; `delete` sends `DeleteObject` with `Key: 'bulk-uploads/x/raw.csv'`. In `index.test.ts`: `getObjectStorage()` before `init` throws `ConfigError`; after `initObjectStorage(parse({}))` returns the same instance twice; `_setObjectStorage(fake)` overrides.
- [ ] **Step 2:** In `s3.test.ts` add `describe.skipIf(!process.env.OBJECT_STORAGE_IT_ENDPOINT)` running `runObjectStorageContract('s3 (MinIO)', …)` against that endpoint (bucket created in `beforeAll`, without the module mock).
- [ ] **Step 3:** Run unit tests → FAIL.
- [ ] **Step 4:** Implement `s3.ts` and `index.ts` (port the client setup from `apps/api/src/services/object-storage/index.ts`).
- [ ] **Step 5:** Run unit tests → PASS. With local MinIO up (`make up`): `OBJECT_STORAGE_IT_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=<MINIO_ROOT_PASSWORD> pnpm --filter @aggregator-dpg/object-storage test -- --pool=forks --maxWorkers=2` → contract suite PASS for both fake and MinIO.
- [ ] **Step 6:** `pnpm --filter @aggregator-dpg/object-storage build && pnpm dep-check` → no violations.
- [ ] **Step 7:** Commit `feat(object-storage): #1055 add the S3 provider and the provider factory`.

### Task 4: web follows the upload instructions

**Files:**
- Modify: `apps/web/src/services/onboarding.service.ts:88-100,256-264`
- Create: `apps/web/src/services/__tests__/onboarding-upload.test.ts`

**Interfaces:**
- Produces: `BulkUploadCreateResponseSchema.upload` optional (`{ method: 'PUT' | 'POST'; url; headers; form_fields }`); module-private `uploadFile(file: File, created: BulkUploadCreateResponse): Promise<void>` sends `upload.method` to `upload.url` — `PUT`: body = file, headers = `upload.headers`; `POST`: `FormData` with every `form_fields` entry then `file` last, headers = `upload.headers`. Without `upload`, falls back to `PUT upload_url` with `Content-Type: content_type`.

- [ ] **Step 1: Write failing tests** with a stubbed `fetch`: PUT instructions → one `PUT` to `upload.url` with the file body and `Content-Type: text/csv`; POST instructions with `form_fields {key:'k', policy:'p'}` → `POST` whose `FormData` keys are `['key','policy','file']` in that order; response without `upload` → `PUT` to `upload_url`; storage answers 403 → rejects with `File upload failed (403)` (no "S3", no response body).
- [ ] **Step 2:** `pnpm --filter @aggregator-dpg/web test -- --pool=forks --maxWorkers=2 src/services/__tests__/onboarding-upload.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `pnpm --filter @aggregator-dpg/web typecheck` → clean.
- [ ] **Step 5:** Commit `refactor(web): #1055 upload bulk CSVs by following upload instructions when the api sends them`. Push; open draft PR 1 into `feature`. Check `git diff --stat origin/feature` ≤ 18 files.

### Task 5: api on the package

**Files:**
- Modify: `apps/api/package.json` (add `@aggregator-dpg/object-storage`, remove `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), `apps/api/src/config.ts` (replace lines 117-133 with `...storageConfigFields`), `apps/api/src/server.ts` (call `initObjectStorage(config)` before `buildApp()`), `apps/api/src/routes/bulk-uploads.ts`, `openapi.json`
- Delete: `apps/api/src/services/object-storage/index.ts`, `apps/api/src/services/object-storage/index.test.ts`
- Test: `apps/api/src/routes/bulk-uploads.test.ts`, `apps/api/src/routes/registration-links.registration-mode.test.ts` (drop the object-storage mock; the route does not use storage)
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `getObjectStorage`, `toStoredKey`, `fromStoredKey`, `FakeObjectStorage`, `_setObjectStorage`.
- Produces: create response gains `upload: { method: 'PUT' | 'POST'; url: string; headers: Record<string,string>; form_fields: Record<string,string> }`; `upload_url` and `content_type` stay, marked `deprecated: true` in the response schema.

- [ ] **Step 1: Update tests first** in `bulk-uploads.test.ts`: replace the module mock with `_setObjectStorage(fake)` in `beforeEach`. Assertions: create → 201 with `upload.method === 'PUT'`, `upload.headers['Content-Type'] === 'text/csv'`, `upload_url === upload.url`, `s3_key === 'bulk-uploads/<agg>/<id>/raw.csv'`; `/start` with a seeded object → 200 and the job carries `s3Key` equal to the stored key; `/start` with nothing seeded → 400 "CSV upload not found"; `/start` on a row whose stored key is `'pending'` → 400 "CSV upload not found" (Review Focus 1); `/start` with `fake.failNext('stat', new UpstreamError('x'))` → 500 `INTERNAL` and the row is still `pending` (Review Focus 2); errors download → `url` from `createDownloadUrl` and `s3_key === 'bulk-uploads/<id>/errors.csv'`; log objects use `storage_key` and reason `storage_object_missing`.
- [ ] **Step 2:** `pnpm --filter @aggregator-dpg/api test -- --pool=forks --maxWorkers=2 src/routes/bulk-uploads.test.ts` → FAIL.
- [ ] **Step 3:** Change `routes/bulk-uploads.ts`: create builds `ref = {area:'bulk-uploads', key:`${aggregatorId}/${uploadId}/raw.csv`}`, calls `createUpload({ref, contentType:'text/csv', maxBytes: config.BULK_UPLOAD_MAX_BYTES, expiresInSeconds: config.BULK_UPLOAD_URL_TTL_SECONDS})`, stores `toStoredKey(ref)`; `/start` uses `fromStoredKey` (error → same 400 as missing) then `stat`; errors download uses `fromStoredKey` on the stored key and `createDownloadUrl({ref, expiresInSeconds: config.BULK_UPLOAD_URL_TTL_SECONDS, filename:'errors.csv', contentType:'text/csv'})`. An error result is thrown as is (500 via `coerceToHttpError`). Rename log fields `s3_key`→`storage_key`, `s3_object_missing`→`storage_object_missing`; route descriptions say "pre-signed upload/download URL", not "S3".
- [ ] **Step 4:** Run the two route test files → PASS; `pnpm --filter @aggregator-dpg/api typecheck` → clean.
- [ ] **Step 5:** `pnpm --filter @aggregator-dpg/api spec:dump` regenerates `openapi.json`.
- [ ] **Step 6:** Commit `refactor(api): #1055 use the object-storage package for bulk uploads and return upload instructions`.

### Task 6: Neutral code names and dead code

**Files:**
- Modify: `packages/db-schema/src/schema.ts` (`storageKey: text('s3_key')`, `contentFingerprint: text('s3_etag')`, `errorsCsvStorageKey: text('errors_csv_s3_key')`), `packages/db-schema/src/__tests__/schema.columns.test.ts`
- Modify: `apps/api/src/services/bulk-uploads-store/interface.ts`, `postgres.ts`, `__tests__/postgres.test.ts` (rename fields; delete `findByAggregatorAndEtag`, the `DUPLICATE_ETAG` error and their tests; the `deletePending` doc no longer mentions the dropped unique index)
- Modify: `apps/api/src/routes/bulk-uploads.ts`, `bulk-uploads.test.ts` (new field names; the job payload still sets `s3Key`; the API fields still `s3_key`, `errors_csv_s3_key`)
- Modify: `apps/worker/src/jobs/bulk-finalise.ts`, `bulk-finalise.test.ts` (`errorsCsvStorageKey` in the Drizzle update only)
- Modify: `apps/web/src/__tests__/app/(protected)/onboarding/CSVUpload.test.tsx` (mocked rejection text `File upload failed (500)`)

- [ ] **Step 1:** Update `schema.columns.test.ts` to assert `bulkUploads.storageKey.name === 's3_key'`, `contentFingerprint.name === 's3_etag'`, `errorsCsvStorageKey.name === 'errors_csv_s3_key'`; run → FAIL.
- [ ] **Step 2:** Rename across the listed files; `pnpm --filter @aggregator-dpg/db-schema build`; `pnpm typecheck --concurrency=1` → clean.
- [ ] **Step 3:** `pnpm --filter @aggregator-dpg/api exec drizzle-kit generate --name noop-check` reports no changes (delete any file it creates).
- [ ] **Step 4:** `pnpm test --concurrency=1 -- --pool=forks --maxWorkers=2` → all PASS.
- [ ] **Step 5:** Commit `refactor(bulk-upload): #1055 neutral storage field names in code and drop the unused ETag finder`. Push; open draft PR 2 (base PR 1). Check ≤ 18 files.

### Task 7: worker on the package, env examples, onboarding docs

**Files:**
- Modify: `apps/worker/package.json`, `apps/worker/src/config.ts:36-49` (→ `...storageConfigFields`), `apps/worker/src/main.ts` (`initObjectStorage(config)` before the workers start), `apps/worker/src/jobs/bulk-file-process.ts:99-110`, `apps/worker/src/jobs/bulk-finalise.ts:120-135`, `apps/worker/src/jobs/campaign-process.ts:50-54`, `apps/worker/src/services/campaign-process/index.ts:26` (import `DownloadUrl` from the package instead of `SignedDownloadUrl`)
- Delete: `apps/worker/src/object-storage.ts`, `apps/worker/src/object-storage.test.ts`
- Test: `apps/worker/src/jobs/bulk-file-process.test.ts`, `bulk-finalise.test.ts`, `campaign-process.test.ts`
- Modify: `pnpm-lock.yaml`, `docs/onboarding-design.md`, `docs/onboarding-implementation.md` (neutral wording; column names unchanged)
- User edits (write-blocked): `.env.example`, `apps/api/.env.example`, `apps/worker/.env.example` — add `STORAGE_PROVIDER=s3` above the `S3_*` block with a one-line note that `s3` is the only provider.

**Interfaces:**
- Consumes: `getObjectStorage`, `fromStoredKey`, `toStoredKey`, `FakeObjectStorage`.
- Keeps unchanged: `ExportCollaborators.putObject(key, body, contentType)` and `signDownloadUrl(key)` signatures, so `services/campaign-process/*.test.ts` stay untouched. `jobs/campaign-process.ts` adapts them: `putObject` → `put({ref: fromStoredKey('exports', key), …})`, `signDownloadUrl` → `createDownloadUrl({…, expiresInSeconds: config.EXPORT_URL_TTL_SECONDS, filename:'participant-export.csv', contentType:'text/csv'})`; an error result is thrown so the job fails and retries as today. `exportObjectKey` keeps returning the full key.

- [ ] **Step 1: Update tests first**: replace the `../object-storage.js` mocks with `_setObjectStorage(fake)`. `bulk-file-process`: a seeded CSV is parsed as before; a missing object fails the job with log `sub: 'storage.get'`. `bulk-finalise`: errors CSV lands at stored key `bulk-uploads/up-1/errors.csv` (`fake.read`), and `fake.failNext('put', …)` fails the job with log `sub: 'storage.put'`. `campaign-process`: the export is written to `campaign-exports/<org>/<job>.csv` and the emailed URL comes from `createDownloadUrl`.
- [ ] **Step 2:** Run the three files → FAIL.
- [ ] **Step 3:** Implement. `bulk-file-process` reads `fromStoredKey('bulk-uploads', job.s3Key)`; a `null` stream is treated like today's empty-body error. Update the two onboarding docs.
- [ ] **Step 4:** `pnpm --filter @aggregator-dpg/worker test -- --pool=forks --maxWorkers=2` → all PASS (including the untouched campaign-process service tests); typecheck clean.
- [ ] **Step 5:** `git grep -n -i -E "\bs3\b|S3 PUT|s3_object_missing|s3\.(put|get)" -- apps packages ':!packages/object-storage/src/s3.ts'` shows only the kept names and `S3_*` settings.
- [ ] **Step 6:** Local end to end against MinIO, desktop and 390×844: upload a CSV with some bad rows, download the errors report; a campaign export email link downloads the CSV.
- [ ] **Step 7:** Commit `refactor(worker): #1055 use the object-storage package for CSV reads, errors CSV and exports`. Ask the user to commit the three `.env.example` lines. Push; open draft PR 3 (base PR 2, `Closes #1055`). Check ≤ 18 files.
