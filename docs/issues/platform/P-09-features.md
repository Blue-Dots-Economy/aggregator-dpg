# P-09 storage package — features

---

## F-09.1 `StorageService` interface + local-disk dev impl

**AC**
- [ ] Interface: `put(key, stream, meta)`, `get(key)`, `exists(key)`, `delete(key)`, `signedUrl(key, { ttlSec, contentDisposition? })`
- [ ] `./local` impl writes under `<tmpDir>/aggregator-storage/`; dev-only
- [ ] All ops accept `AbortSignal`

**Tasks**
- [ ] T-09.1.1 Interface
- [ ] T-09.1.2 Local-disk impl

---

## F-09.2 S3/GCS impl

**AC**
- [ ] `./s3` impl using `@aws-sdk/client-s3`; configurable endpoint (for MinIO compat)
- [ ] Server-side encryption on by default
- [ ] MIME + size validated before upload

**Tasks**
- [ ] T-09.2.1 S3 client
- [ ] T-09.2.2 Put/get/delete
- [ ] T-09.2.3 Encryption config

---

## F-09.3 Signed URL generation + TTL

**AC**
- [ ] Default TTL 1 h, configurable per call up to `storage.signedUrl.maxTtlSec`
- [ ] Signed URLs for GET only; no signed-upload in MVP

**Tasks**
- [ ] T-09.3.1 Signer
- [ ] T-09.3.2 Config guardrails

---

## F-09.4 Retention/purge job

**AC**
- [ ] A `QueueService` worker `storage.purge` scans objects older than `storage.retention.days` (default 7) and deletes
- [ ] Dry-run mode via config flag

**Tasks**
- [ ] T-09.4.1 Worker
- [ ] T-09.4.2 Schedule via queue recurring-job
- [ ] T-09.4.3 Dry-run flag
