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

| Object | Contents |
|---|---|
| `bulk-uploads/{aggregator_id}/{upload_id}/raw.csv` | Raw participant CSV — **name, phone, and every other profile field** |
| `bulk-uploads/{upload_id}/errors.csv` | Failed rows, verbatim — same PII |
| `qr/{aggregator_id}/{link_id}.png` | Registration-link QR codes |

Anyone who can guess or obtain a key can `GET` it with a spoofed `Referer` and no credentials. Object
keys embed UUIDs so they are not trivially enumerable, but that is obscurity, not access control.

**The good news: almost all of the application-side work is already done.** This repo never hands a
durable object URL to a browser. It presigns every browser interaction and persists object **keys**,
not URLs:

- `bulk_uploads.s3_key` (`packages/db-schema/src/schema.ts:290`)
- `bulk_uploads.errors_csv_s3_key` (`:296`)
- `registration_links.qr_object_key` (`:332`)

`registration_links.public_url` is the **landing-page** URL built from `PUBLIC_LINK_BASE_URL`, not an
S3 URL. So **there is no persisted-public-URL backfill to do in this repo.** Making the bucket
private is, for the application, mostly a configuration change plus the three corrections in §3.

## 2. Current object-storage surface

**`apps/api/src/services/object-storage/index.ts`** — two cached clients: `getInternalClient()` on
`S3_ENDPOINT` for server-side ops, `getPresignerClient()` on `S3_PUBLIC_ENDPOINT || S3_ENDPOINT`
because a pre-signed URL encodes the host the browser must reach.

| Export | Line | Role |
|---|---|---|
| `signBulkUploadUrl` | `:86` | pre-signed **PUT**, `ContentType: text/csv` signed in |
| `headObject` | `:120` | confirm the browser's PUT landed, capture ETag |
| `putObject` | `:142` | server-side write (QR PNG) |
| `signErrorsCsvDownloadUrl` | `:166` | pre-signed **GET**, `Content-Disposition: attachment` |
| `signQrDownloadUrl` | `:184` | pre-signed **GET** for the QR PNG |

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
downloads borrow the *upload* TTL (`index.ts:174` — noted in its own comment as a reuse).

Introduce a single canonical key and make the existing two optional overrides:

| Var | Default | Applies to |
|---|---|---|
| `SIGNED_URL_TTL_SECONDS` | **600** | every pre-signed URL this service mints |
| `BULK_UPLOAD_URL_TTL_SECONDS` | *(unset → falls back)* | upload PUT only |
| `QR_DOWNLOAD_URL_TTL_SECONDS` | *(unset → falls back)* | QR GET only |

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
old objects keep resolving. Only newly created objects get new keys. `bulk-uploads.ts:627` rebuilds
the expected errors key from `upload.id` — that derivation must switch to reading
`errors_csv_s3_key` from the row rather than recomputing, otherwise old rows break. This is the one
genuine correctness trap in the change.

### 3.3 Object classification for lifecycle expiry

The bucket lifecycle rules themselves are infrastructure (`bluedots-automation`), but the
classification is a product decision and belongs here. `apps/worker/src/jobs/cron-watchdog.ts:11`
already documents the assumption that "S3 lifecycle (raw CSVs + errors.csv) is configured externally"
— that configuration has never existed.

| Class | Prefix | Retention | Rationale |
|---|---|---|---|
| Raw upload CSV | `uploads/raw/` | **7 days** | Consumed by the worker within minutes. Kept a week only so a failed run can be re-driven and support can reproduce a complaint. Highest-PII object we hold — shortest life. |
| Errors CSV | `uploads/errors/` | **30 days** | The aggregator's own worklist for fixing rejected rows; they need more than a week to act, and the dashboard links to it. |
| QR PNG | `qr/` | **durable — never expires** | Deterministically regenerable from the link, but a printed QR outlives any TTL; expiring it breaks physical collateral already in the field. |

Retention is deployment-configurable, not hardcoded — see the automation doc for variable names.

**Versioning interacts with this.** If the private bucket has versioning enabled (the existing
`private` bucket template does), a plain `Expiration` rule only adds a delete marker — the PII stays
in a noncurrent version forever. Every transient rule **must** be paired with
`NoncurrentVersionExpiration`, plus `AbortIncompleteMultipartUpload`. Missing this is the most likely
way this change ships looking complete while retaining every CSV indefinitely.

### 3.4 Nothing else moves

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
- The `{aggregator_id}` segment in a key is a *grouping and lifecycle* device, not an authorization
  boundary. Authorization is the row-ownership check. Do not let the prefix become load-bearing.
- Pre-signed URLs are bearer credentials for one object. They must never be logged
  (`.claude/rules/logging-observability.md`) or persisted. Audit the *mint event* with the key, not
  the URL.

## 5. Test plan (Vitest)

- `signBulkUploadUrl` / `signQrDownloadUrl` / `signErrorsCsvDownloadUrl` honour
  `SIGNED_URL_TTL_SECONDS`, and each per-class override wins when set.
- Boot fails when `SIGNED_URL_TTL_SECONDS` exceeds the 3600s ceiling.
- New objects get `uploads/raw/…` / `uploads/errors/…` keys with the `aggregator_id` segment.
- **Legacy-key regression:** a `bulk_uploads` row whose `errors_csv_s3_key` is the old
  `bulk-uploads/{id}/errors.csv` still presigns and downloads. This is the test that catches §3.2's
  trap.
- Cross-tenant: aggregator B requesting A's `upload_id` gets 404/403 and **no URL is minted**.
- Existing bulk-upload and registration-link suites pass unchanged — the presign surface is stable.

Integration coverage runs against MinIO, which is already private, so the local suite exercises the
target posture without new fixtures.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Bucket flipped to private before objects are copied → existing downloads 404 | Automation/infra sequencing: provision private, sync, *then* flip. See the infra-deployments doc. |
| CORS missing on the private bucket → browser PUT fails preflight | The private bucket **must** carry `cors_enabled: true`. The current `private` bucket template does not. Called out in the automation doc. |
| `bulk-uploads.ts:627` key recomputation left in place | Covered by the legacy-key test above. |
| TTL shortened too aggressively → large CSV upload times out mid-PUT | 600s at 10 MiB (`BULK_UPLOAD_MAX_BYTES`) is ~140 kbit/s to fail; acceptable. Keep `BULK_UPLOAD_URL_TTL_SECONDS` as the override for slow-link environments. |

## 7. Open questions

1. Should `qr/` objects move behind a short-lived redirect endpoint instead of a raw pre-signed GET,
   so a leaked QR URL dies with the TTL rather than the printed code? Out of scope here.
2. Is 30 days right for `uploads/errors/`, or should it track a stated data-retention commitment to
   aggregators? Needs a product answer, not an engineering one.
3. The `signals-export` bucket is already `type: private` and written by a separate write-only IRSA
   role. Confirmed out of scope for this change.
